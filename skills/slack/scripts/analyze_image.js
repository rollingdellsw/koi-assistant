// scripts/analyze_image.js
async function run() {
  const fileId = args[0];
  if (!fileId) return { error: "fileId is required" };

  console.log(`🖼 Analyzing image file: ${fileId}`);

  // 1. Get file info to get url_private
  const infoRes = await tools.slack_files_info({ file: fileId });
  if (infoRes.isError) return { error: "Could not get file info" };
  const fileInfo = JSON.parse(String(infoRes.content[0].text));

  if (!fileInfo.urlPrivate) return { error: "No private URL for file" };

  // 2. Download base64
  const dlRes = await tools.slack_files_download({
    url_private: fileInfo.urlPrivate,
    returnRawBase64: true,
  });
  if (dlRes.isError) return { error: "Download failed" };

  let base64 = null;
  for (const block of dlRes.content || []) {
    try {
      const parsed = JSON.parse(String(block.text));
      if (typeof parsed.base64 === "string") {
        base64 = parsed.base64;
        break;
      }
    } catch (_) {}
  }
  if (!base64) return { error: "No base64 payload" };

  // 3. Run vision subtask
  console.log("🧠 Running vision subtask...");
  const subtaskRes = await tools.run_subtask({
    goal: `Describe the image "${fileInfo.name}" in 2-4 concise sentences. Focus on visible text and main subject.`,
    verification_command: "Image is described",
    image_data: [{ base64, mimeType: fileInfo.mimetype, filename: fileInfo.name }],
    timeoutMs: 90000,
  });

  if (subtaskRes && !subtaskRes.isError && Array.isArray(subtaskRes.content)) {
    let desc = String(subtaskRes.content[0].text);
    try {
      const parsed = JSON.parse(desc);
      if (parsed.content) desc = parsed.content;
    } catch (_) {}
    return { success: true, description: desc };
  }
  return { error: "Vision subtask failed" };
}
return run();