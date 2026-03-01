# HF_HUB_ENABLE_HF_TRANSFER=1 hf download  openai/gpt-oss-20b --include "*" --local-dir models/gpt-oss-20b

docker run -it   --device /dev/dri --device /dev/kfd   \
    --group-add video --group-add render   --security-opt seccomp=unconfined   --network host   \
    -v ~/.cache/huggingface:/root/.cache/huggingface   \
    -v ${HOME}/models:/models \
    docker.io/kyuz0/vllm-therock-gfx1151:latest

# /opt# vllm serve /models/gpt-oss-20b \
#       --gpu-memory-utilization 0.95 \
#       --max-model-len 128000 \
#       --allowed-origins '["*"]'
