#!/usr/bin/env python3
"""Download Verdict model files from Hugging Face"""

import os
import sys
from pathlib import Path

try:
    from huggingface_hub import hf_hub_download, snapshot_download
except ImportError:
    print("Error: huggingface_hub not installed")
    print("Install with: pip install huggingface_hub")
    sys.exit(1)

# Configuration - Use public checkpoint
REPO_ID = "heman10x/rlcd-modernbert-151m"
MODEL_DIR = Path(__file__).parent.parent / "server" / "artifacts" / "v2"

def main():
    print(f"Downloading Verdict model from Hugging Face...")
    print(f"Repository: {REPO_ID}")
    print(f"Target: {MODEL_DIR}")
    print()

    # Create directory
    MODEL_DIR.mkdir(parents=True, exist_ok=True)

    # Download entire repository
    print("Downloading model files...")
    try:
        snapshot_download(
            repo_id=REPO_ID,
            local_dir=str(MODEL_DIR),
            local_dir_use_symlinks=False,
        )
        print()
        print("✓ Model downloaded successfully!")
        print(f"Location: {MODEL_DIR}")
        
        # List downloaded files
        print()
        print("Downloaded files:")
        for f in sorted(MODEL_DIR.iterdir()):
            if f.is_file():
                size = f.stat().st_size
                if size > 1024*1024:
                    print(f"  {f.name}: {size//1024//1024}MB")
                else:
                    print(f"  {f.name}: {size//1024}KB")
                    
    except Exception as e:
        print(f"✗ Failed to download: {e}")
        sys.exit(1)

if __name__ == "__main__":
    main()
