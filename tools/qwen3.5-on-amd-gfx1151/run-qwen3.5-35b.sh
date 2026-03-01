# docker build -t llama-rocm -f Dockerfile

# HF_HUB_ENABLE_HF_TRANSFER=1 hf download unsloth/Qwen3.5-35B-A3B-GGUF \
#	Qwen3.5-35B-A3B-UD-Q5_K_XL.gguf \
#	--local-dir models/Qwen3.5-35B-A3B-UD-Q5_K_XL-GGUF
# HF_HUB_ENABLE_HF_TRANSFER=1 hf download unsloth/Qwen3.5-35B-A3B-GGUF mmproj-BF16.gguf \
#	--local-dir models/Qwen3.5-35B-A3B-UD-Q5_K_XL-GGUF

docker run -it --rm \
  --device=/dev/kfd --device=/dev/dri \
  --group-add video --group-add render \
  -v ${HOME}/models:/models \
  -p 8080:8080 \
  llama-rocm \
  -m /models/Qwen3.5-35B-A3B-GGUF/Qwen3.5-35B-A3B-UD-Q5_K_XL.gguf \
  --mmproj /models/Qwen3.5-35B-A3B-GGUF/mmproj-BF16.gguf \
  -c 262144 -fa on -ngl 999 --no-mmap \
  --host 0.0.0.0 --port 8080
