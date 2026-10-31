# New Machine Setup & Getting Started Guide (Level 0 & Level 1)

This comprehensive guide takes you step-by-step from cloning the repository on a fresh PC or laptop (Windows, macOS, or Linux) to successfully launching and running **ReflectWorld** in either **Level 0 (Cloud VLM / Lightweight Mode)** or **Level 1 (Local Edge ONNX Inference Mode)**.

---

## 1. System Requirements & Architecture Selection

| Component | Level 0 Mode (Cloud VLM) | Level 1 Mode (Local Edge AI) |
| :--- | :--- | :--- |
| **Target Hardware** | Any standard laptop / desktop / cloud VM | Workstation / Laptop with dedicated GPU or Apple Silicon |
| **GPU Requirement** | **None** (runs entirely on CPU + cloud API) | NVIDIA GPU (>= 6GB VRAM, CUDA 12+) or Apple M-Series |
| **Perception Engine** | Gemini 3.1 Flash Lite via Cloud API | Local ONNX: YOLO26m, RetinaFace, ArcFace, RTMPose |
| **Node.js** | `>= 22.0.0` (LTS recommended) | `>= 22.0.0` (LTS recommended) |
| **Python** | `>= 3.11` | `>= 3.11` (with CUDA/ONNX runtime support) |
| **Disk Space** | ~3 GB (binaries + dependencies) | ~15 GB (models, weights, build tools) |
| **Memory (RAM)** | 8 GB minimum | 16 GB minimum |

---

## 2. Global System Prerequisites

Before running any setup scripts, ensure the following tools are installed on your machine and available in your system `PATH`:

### 2.1 Git
- **Windows**: Download and install [Git for Windows](https://git-scm.com/download/win).
- **macOS**: Run `brew install git`.
- **Linux**: Run `sudo apt update && sudo apt install -y git`.

### 2.2 Node.js & Corepack
- Install **Node.js 22 LTS** from [nodejs.org](https://nodejs.org).
- Verify in your terminal:
  ```bash
  node -v   # Must be >= 22.0.0
  npm -v    # Must be >= 10.0.0
  ```

### 2.3 Python 3.11+
- Install **Python 3.11 or 3.12** from [python.org](https://www.python.org/downloads/).
- *Windows Users*: Make sure to check **"Add python.exe to PATH"** during installation.
- Verify in terminal:
  ```bash
  python --version   # Must be >= 3.11.0
  ```

### 2.4 FFmpeg
ReflectWorld uses FFmpeg for video demuxing, audio track splitting, and keyframe extraction.
- **Windows**:
  - Download from [gyan.dev/ffmpeg/builds](https://www.gyan.dev/ffmpeg/builds/) or install via winget:
    ```powershell
    winget install Gyan.FFmpeg
    ```
- **macOS**:
  ```bash
  brew install ffmpeg
  ```
- **Linux**:
  ```bash
  sudo apt install -y ffmpeg
  ```
- Verify:
  ```bash
  ffmpeg -version
  ```

---

## 3. Clone & Environment Configuration

### 3.1 Clone the Repository
```bash
git clone https://github.com/Samrat-Madake/Cortex.git
cd Cortex
```

### 3.2 Configure the Root `.env`
Navigate to the `ReflectWorld` subfolder and create your environment configuration:

```bash
cd ReflectWorld
cp .env.example .env
```
*(On Windows PowerShell, use: `Copy-Item .env.example .env`)*

Now open `ReflectWorld/.env` in your text editor and configure:

```env
# 1. API Keys (Required for Level 0, Optional for pure Level 1)
GEMINI_API_KEY=your_gemini_api_key_here

# 2. VLM Perception Settings (Level 0 default)
PERCEPTION_LEVEL=0
VLM_PROVIDER=gemini
GEMINI_MODEL=gemini-3.1-flash-lite
VLM_MAX_RETRIES=4
VLM_FRAME_RESIZE_ENABLED=true

# 3. Microservice Endpoints
QDRANT_URL=http://localhost:6333
MEM_SERVICE_URL=http://localhost:8219
PORT=3210
HOST=0.0.0.0
```

> [!TIP]
> Get a free Google Gemini API key at [aistudio.google.com](https://aistudio.google.com). Use model `gemini-3.1-flash-lite` to ensure reliable throughput and avoid deprecated aliases.

---

## 4. Install Monorepo & Python Dependencies

From the repository root or `ReflectWorld` directory:

### 4.1 Install Node Monorepo Packages
```bash
cd ReflectWorld
npm install
npm run build
```
This builds all TypeScript workspaces (`packages/shared`, `packages/cam`, `packages/percept`, `packages/mem`, `packages/reflectworld`, `packages/dashboard`, `packages/host`).

### 4.2 Set Up Python Memory Service Virtual Environment
The memory service manages Qdrant collections, FastEmbed dense vectors, and temporal schema consolidation.

```bash
cd services/mem

# Windows PowerShell:
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install --upgrade pip
pip install -r <(python -c "import tomli; ...") # Or install pyproject dependencies:
pip install uvicorn fastapi qdrant-client fastembed python-dotenv pydantic requests pillow

# macOS / Linux:
python3 -m venv .venv
source .venv/bin/activate
pip install --upgrade pip
pip install uvicorn fastapi qdrant-client fastembed python-dotenv pydantic requests pillow
```

---

## 5. Setup Qdrant Vector Database

ReflectWorld stores memories across 9 vector collections in Qdrant. You can run Qdrant either via Docker or as a standalone binary:

### Option A: Standalone Binary (Recommended for Windows / Quick Setup)
1. Download the latest Qdrant release from [Qdrant GitHub Releases](https://github.com/qdrant/qdrant/releases).
2. Extract to a directory (e.g., `C:\qdrant\qdrant.exe` on Windows or `/usr/local/bin/qdrant` on Linux/macOS).
3. *(Optional)* Download the static Web UI files to `C:\qdrant\static` so you can use the interactive dashboard at `http://localhost:6333/dashboard`.

### Option B: Docker Container
```bash
docker run -d -p 6333:6333 -p 6334:6334 \
    -v $(pwd)/qdrant_storage:/qdrant/storage:z \
    qdrant/qdrant
```

---

## 6. How to Run: Level 0 Setup (Cloud VLM / Standard Laptop)

Level 0 runs the full perception pipeline using Google Gemini 3.1 Flash Lite for scene understanding, requiring **zero local model downloads or GPU setup**.

Open **3 separate terminal windows** for visibility and monitoring:

### Terminal 1: Qdrant Vector Store
```powershell
# Windows:
cd C:\qdrant
.\qdrant.exe

# Linux / macOS:
./qdrant
```
*Expected output: `Qdrant HTTP listening on 6333`*

### Terminal 2: Python Memory Service
```powershell
# Windows:
cd ReflectWorld\services\mem
.\.venv\Scripts\Activate.ps1
python -m uvicorn src.main:app --host 127.0.0.1 --port 8219

# Linux / macOS:
cd ReflectWorld/services/mem
source .venv/bin/activate
python -m uvicorn src.main:app --host 127.0.0.1 --port 8219
```
*Expected output: `Uvicorn running on http://127.0.0.1:8219` and 9 Qdrant collections initialized.*

### Terminal 3: Main ReflectWorld Orchestrator & Dashboard
```powershell
cd ReflectWorld
node packages/reflectworld/dist/src/cli/index.js start --dev
```
*Expected output:*
- Automatic self-check verifies Qdrant, Python Memory Service, FFmpeg, and Gemini API.
- `ReflectWorld running at http://localhost:3210`

### Testing Your Video:
1. Open your browser at **`http://localhost:3210`**.
2. Click **Add Source** $\to$ Upload an `.mp4` video.
3. Observe live keyframes extracted in Terminal 3, VLM scene descriptions streaming, and memories indexed in Terminal 2.
4. Click the bottom-right **Chat** button and query: *"What happened in this video?"*

---

## 7. How to Run: Level 1 Setup (Local Edge ONNX Inference)

Level 1 replaces Cloud VLM API calls with high-performance local edge computer vision models running via ONNX Runtime (YOLO26m, RetinaFace, ArcFace, RTMPose).

### 7.1 Additional Prerequisites for Level 1
- **NVIDIA GPU**: Install [CUDA 12.x Toolkit](https://developer.nvidia.com/cuda-toolkit) and [cuDNN](https://developer.nvidia.com/cudnn).
- **C++ Build Tools**:
  - Windows: Visual Studio Community with "Desktop development with C++".
  - Linux: `sudo apt install build-essential`.
  - macOS: Xcode Command Line Tools (`xcode-select --install`).

### 7.2 Download ONNX Model Weights
Place the required `.onnx` models into your system model directory:
- Windows: `C:\Users\<YOUR_USERNAME>\.reflectworld\models\`
- Linux/macOS: `~/.reflectworld/models/`

Required model files:
1. `yolo26m.onnx` (Object detection & spatial reasoning)
2. `retinaface-resnet50.onnx` (Face detection & 5-point alignment)
3. `w600k_mbf.onnx` (ArcFace 512-d facial embeddings)
4. `rtmpose-m.onnx` (17-keypoint skeleton pose estimation)

### 7.3 Configure `.env` for Level 1
In `ReflectWorld/.env`, update:
```env
# Switch perception level to 1
PERCEPTION_LEVEL=1

# Local inference providers
DETECTION_PROVIDER=yolo26m-builtin
FACE_DETECTION_PROVIDER=retinaface-builtin
FACE_EMBEDDING_PROVIDER=adaface-builtin
POSE_PROVIDER=rtmpose-builtin

# Hardware acceleration: 'cuda', 'coreml', or 'cpu'
ONNX_EXECUTION_PROVIDER=cuda
```

### 7.4 Start Level 1 Pipeline
Re-launch the 3 terminals:
1. **Terminal 1**: Qdrant (`.\qdrant.exe` on port 6333)
2. **Terminal 2**: Python Memory Service (`uvicorn src.main:app --port 8219`)
3. **Terminal 3**: Orchestrator (`node packages/reflectworld/dist/src/cli/index.js start --dev`)

The startup self-check will report:
```
[MODEL INFO] Provider "yolo26m-builtin" enabled (CUDAExecutionProvider).
[MODEL INFO] Provider "retinaface-builtin" enabled.
[MODEL INFO] Provider "adaface-builtin" enabled.
[reflectworld] Local edge inference pipeline ACTIVE.
```

---

## 8. Common Troubleshooting & Error Resolution

### 1. `Invalid value drop specified for fps_mode` (FFmpeg exit code 4294967274)
- **Cause**: Newer FFmpeg versions deprecated `-fps_mode drop`.
- **Fix**: Use `-fps_mode vfr` in `packages/cam/src/local-file-media-source.ts`. Already patched in repository.

### 2. Gemini 404 / 503 Errors
- **Cause**: Using retired model names (`gemini-1.5-flash`) or heavily saturated endpoints (`gemini-3.8-flash`).
- **Fix**: Set `GEMINI_MODEL=gemini-3.1-flash-lite` in `ReflectWorld/.env`.

### 3. Port Conflicts (`EADDRINUSE: 3210`, `8219`, `6333`)
- **Fix**: Terminate old background processes:
  - Windows PowerShell:
    ```powershell
    Get-Process node, python, qdrant -ErrorAction SilentlyContinue | Stop-Process -Force
    ```
  - Linux / macOS:
    ```bash
    killall node python3 qdrant
    ```

### 4. Python Memory Service `ModuleNotFoundError`
- **Fix**: Ensure you have activated your virtual environment (`.\.venv\Scripts\Activate.ps1` or `source .venv/bin/activate`) before running Uvicorn.

---

## 9. Quick Architecture Document Links

For deeper technical details, explore our full architecture suite:
- [**Phase 1: Project Overview & Benchmarks**](file:///c:/Users/DELL/Desktop/Mega%20Project%20folder/docs/01_PROJECT_OVERVIEW.md)
- [**Phase 2: High-Level Design (HLD) & Vector Schemas**](file:///c:/Users/DELL/Desktop/Mega%20Project%20folder/docs/02_HIGH_LEVEL_DESIGN.md)
- [**Phase 3: Codebase Architecture & Monorepo Manual**](file:///c:/Users/DELL/Desktop/Mega%20Project%20folder/docs/03_CODEBASE_ARCHITECTURE.md)
- [**Phase 4: Feature Deep Dive & Algorithms**](file:///c:/Users/DELL/Desktop/Mega%20Project%20folder/docs/04_FEATURE_DEEP_DIVE.md)
