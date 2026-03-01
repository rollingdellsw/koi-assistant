# =============================================================================
# llama.cpp + ROCm Docker Image for AMD Radeon (gfx1151)
# =============================================================================
# Build:
#   docker build -t llama-rocm .
#
# Run:
#   docker run -it --rm \
#     --device=/dev/kfd --device=/dev/dri \
#     --group-add video --group-add render \
#     -v ${HOME}/models:/models \
#     -p 8080:8080 \
#     llama-rocm \
#     ./llama-server \
#       -m /models/Qwen3.5-122B-A10B-UD-Q5_K_XL/UD-Q5_K_XL/Qwen3.5-122B-A10B-UD-Q5_K_XL-00001-of-00003.gguf \
#       --mmproj /models/Qwen3.5-122B-A10B-GGUF/mmproj-BF16.gguf \
#       -c 32768 -fa on -ngl 999 --no-mmap \
#       --host 0.0.0.0 --port 8080
# =============================================================================

FROM rocm/dev-ubuntu-24.04:7.0.2

ARG LLAMA_CPP_TAG=b8179
ARG AMDGPU_TARGETS=gfx1151

# Avoid interactive prompts
ENV DEBIAN_FRONTEND=noninteractive

# ---- System dependencies ----
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    cmake \
    build-essential \
    python3-pip \
    python3-setuptools \
    python3-wheel \
    wget \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# ---- ROCm HIP libraries needed for llama.cpp build ----
RUN apt-get update && apt-get install -y --no-install-recommends \
    hipblas-dev \
    rocblas-dev \
    rocwmma-dev \
    && rm -rf /var/lib/apt/lists/*

# ---- ROCm environment ----
ENV PATH="/opt/rocm/bin:${PATH}"
ENV LD_LIBRARY_PATH="/opt/rocm/lib"
ENV HSA_OVERRIDE_GFX_VERSION=11.5.1
ENV ROCM_PATH=/opt/rocm

# ---- HuggingFace CLI for model downloads ----
RUN pip install --break-system-packages huggingface_hub[cli] hf_transfer

ENV HF_HUB_ENABLE_HF_TRANSFER=1

# ---- Build llama.cpp with ROCm + RPC + Flash Attention ----
WORKDIR /build

RUN git clone https://github.com/ggml-org/llama.cpp -b ${LLAMA_CPP_TAG} \
    && cd llama.cpp \
    && cmake -B build \
        -DGGML_HIP=ON \
        -DGGML_RPC=ON \
        -DGGML_HIP_ROCWMMA_FATTN=ON \
        -DAMDGPU_TARGETS="${AMDGPU_TARGETS}" \
        -DCMAKE_BUILD_TYPE=Release \
    && cmake --build build --config Release -j$(nproc)

# ---- Install binaries ----
WORKDIR /app
RUN cp /build/llama.cpp/build/bin/* /app/ \
    && rm -rf /build

# ---- Models mount point ----
VOLUME /models

EXPOSE 8080

# Default: run llama-server (user overrides args at docker run)
ENTRYPOINT ["/app/llama-server"]
CMD ["--help"]
