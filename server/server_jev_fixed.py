"""Jev-compatible HTTP server for OpenJev decision engine.

Implements the TypeSafe Jev API contract (POST /v1/systemone) so pi-jev can connect.
"""

from typing import Literal
import time
import json
import sys
from typing import Any, Dict, List, Optional, Union
from pathlib import Path
from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from typing_extensions import Annotated
# Add parent to path to import rlcd
sys.path.insert(0, str(Path(__file__).parent))

from rlcd import DecisionEngine, Choice, Score, Noul, Level

# Initialize engine on startup
engine: Optional[DecisionEngine] = None


def get_engine() -> DecisionEngine:
    """Get or initialize the decision engine."""
    global engine
    if engine is None:
        import logging
        logging.basicConfig(level=logging.INFO)
        # Load from local artifacts, fallback to HuggingFace
        repo_root = Path(__file__).parent
        # Try v2 first (has ONNX models)
        model_path = repo_root / "artifacts" / "v2"
        if model_path.exists() and (model_path / "model.safetensors").exists():
            logging.info(f"Loading model from {model_path}")
            engine = DecisionEngine(model_name_or_path=str(model_path))
        else:
            # Fallback to public HF model
            logging.info("Loading model from HuggingFace: heman10x/rlcd-modernbert-151m")
            engine = DecisionEngine(model_name_or_path="heman10x/rlcd-modernbert-151m")
    return engine


# Pydantic models for Jev API


class NoulQuestion(BaseModel):
    type: Literal["noul"] = "noul"
    instructions: Union[str, Dict[str, Any], List[Any]]
    criteria: Optional[Dict[str, Union[str, Dict[str, Any], List[Any]]]] = None


class ChoiceQuestion(BaseModel):
    type: Literal["choice"] = "choice"
    instructions: Union[str, Dict[str, Any], List[Any]]
    criteria: Dict[str, Optional[Union[str, Dict[str, Any], List[Any]]]]


class ScoreQuestion(BaseModel):
    type: Literal["score"] = "score"
    instructions: Union[str, Dict[str, Any], List[Any]]
    criteria: List[Union[str, Dict[str, Any], List[Any]]]


Question = Annotated[Union[NoulQuestion, ChoiceQuestion, ScoreQuestion], Field(discriminator="type")]


class JevRequest(BaseModel):
    state: Union[str, Dict[str, Any], List[Any]]
    model: str = "jev-latest"
    questions: Dict[str, Question]

    model_config = {"extra": "allow"}  # Allow extra fields like request extensions


class NoulAnswer(BaseModel):
    type: str = "noul"
    noul: float


class ChoiceAnswer(BaseModel):
    type: str = "choice"
    choice: str
    probabilities: Dict[str, float]
    confidence: float


class ScoreAnswer(BaseModel):
    type: str = "score"
    score: float
    legend: Dict[str, str]


Answer = Union[NoulAnswer, ChoiceAnswer, ScoreAnswer]


class JevResponse(BaseModel):
    model: str
    answers: Dict[str, Answer]
    usage: Dict[str, int]

JevRequest.model_rebuild()

# FastAPI app
app = FastAPI(title="OpenJev Jev-Compatible Server", version="1.0.0")


@app.on_event("startup")
async def startup():
    """Initialize the engine on startup."""
    get_engine()


@app.post("/v1/systemone", response_model=JevResponse)
async def evaluate(request: JevRequest):
    """Jev-compatible evaluation endpoint.

    Converts Jev API requests to OpenJev queries, evaluates, and formats response.
    """
    try:
        eng = get_engine()

        # Convert state to string
        if isinstance(request.state, str):
            context = request.state
        else:
            context = json.dumps(request.state, indent=2)

        # Convert questions to OpenJev Query objects
        queries = []
        question_ids = []

        for qid, q in request.questions.items():
            question_ids.append(qid)

            if isinstance(q, NoulQuestion):
                # Noul is a yes/no question
                instructions = q.instructions
                if isinstance(instructions, (dict, list)):
                    instructions = json.dumps(instructions)

                queries.append(Noul(
                    id=qid,
                    proposition=instructions,
                    semantics="conditional_on_sufficient_evidence_v2"
                ))
            elif isinstance(q, ChoiceQuestion):
                instructions = q.instructions
                if isinstance(instructions, (dict, list)):
                    instructions = json.dumps(instructions)

                # Build options from criteria
                options = []
                for opt_id, opt_desc in q.criteria.items():
                    desc = opt_desc
                    if isinstance(desc, (dict, list)):
                        desc = json.dumps(desc)
                    elif desc is None:
                        desc = opt_id
                    options.append({"id": opt_id, "description": desc})

                queries.append(Choice(
                    id=qid,
                    question=instructions,
                    options=options
                ))

            elif isinstance(q, ScoreQuestion):
                instructions = q.instructions
                if isinstance(instructions, (dict, list)):
                    instructions = json.dumps(instructions)


                # Score uses levels as options
                levels = []
                for idx, level in enumerate(q.criteria):
                    desc = level
                    if isinstance(desc, (dict, list)):
                        desc = json.dumps(desc)
                    levels.append(Level(
                        id=str(idx),
                        description=desc,
                        value=float(idx)
                    ))

                queries.append(Score(
                    id=qid,
                    question=instructions,
                    levels=levels
                ))

        start = time.perf_counter()
        result = eng.evaluate(context=context, queries=queries)
        elapsed_ms = (time.perf_counter() - start) * 1000

        # Convert results to Jev answers
        answers = {}
        for r in result.results:
            if r.kind == "noul":
                # Map noul result: probability of "true" option
                true_prob = r.probabilities.get("true", 0.5)
                answers[r.id] = NoulAnswer(
                    type="noul",
                    noul=true_prob
                )

            elif r.kind == "choice":
                answers[r.id] = ChoiceAnswer(
                    type="choice",
                    choice=r.selected_id,
                    probabilities=r.probabilities,
                    confidence=r.selected_probability
                )

            elif r.kind == "score":
                # Score is probability-weighted value
                score_value = 0.0
                for level_id, prob in r.probabilities.items():
                    # Skip non-numeric IDs (like __insufficient_evidence__)
                    try:
                        score_value += int(level_id) * prob
                    except ValueError:
                        pass
                q = request.questions[r.id]
                legend = {}
                if isinstance(q, ScoreQuestion):
                    for idx, level in enumerate(q.criteria):
                        desc = level if isinstance(level, str) else json.dumps(level)
                        legend[str(idx)] = desc

                answers[r.id] = ScoreAnswer(
                    type="score",
                    score=score_value,
                    legend=legend
                )

        # Estimate token usage (rough approximation)
        context_tokens = len(context.split()) if isinstance(context, str) else len(json.dumps(context).split())
        question_tokens = sum(
            len(json.dumps(q.dict()).split())
            for q in request.questions.values()
        )
        answer_tokens = sum(
            len(json.dumps(a.dict()).split())
            for a in answers.values()
        )

        return JevResponse(
            model="openJev-verdict-2.0",
            answers=answers,
            usage={
                "input_tokens": context_tokens + question_tokens,
                "output_tokens": answer_tokens,
            }
        )

    except Exception as e:
        import traceback
        traceback.print_exc()
        raise HTTPException(500, f"Evaluation failed: {str(e)}")


@app.get("/health")
async def health():
    """Health check endpoint."""
    return {"status": "ok", "model": "openJev-verdict-2.0"}


@app.get("/")
async def root():
    """Root endpoint with API info."""
    return {
        "name": "OpenJev Jev-Compatible Server",
        "version": "1.0.0",
        "endpoints": {
            "/v1/systemone": "Jev-compatible evaluation endpoint",
            "/health": "Health check",
        }
    }


def main():
    """Run the server with uvicorn."""
    import uvicorn
    import argparse

    parser = argparse.ArgumentParser(description="Run OpenJev Jev-compatible server")
    parser.add_argument("--host", default="127.0.0.1", help="Host to bind to")
    parser.add_argument("--port", type=int, default=8011, help="Port to bind to")
    parser.add_argument("--reload", action="store_true", help="Enable auto-reload for development")

    args = parser.parse_args()

    print(f"Starting OpenJev Jev-compatible server at http://{args.host}:{args.port}")
    print(f"Jev API endpoint: POST http://{args.host}:{args.port}/v1/systemone")
    print(f"Health check: GET http://{args.host}:{args.port}/health")
    print("\nConfigure pi-jev with:")
    print(f'  export TYPESAFE_BASE_URL="http://{args.host}:{args.port}"')
    print("\nPress Ctrl+C to stop.\n")

    uvicorn.run(
        "server_jev_fixed:app",
        host=args.host,
        port=args.port,
        reload=args.reload,
    )


if __name__ == "__main__":
    main()
