# 本地 Whisper 模型配置

既有字幕的获取、复制和导出不需要语音模型。只有“音频转字幕”需要模型与推理运行时。

本仓库未附 ONNX 权重，也不会自动从第三方下载。请将完整、相互兼容的 Transformers.js 模型导出放在扩展的 `models/` 目录，再重新加载扩展。仅有 tokenizer 与 config JSON 不足以进行转写。

## 加载路径

| 路径 | 推理设置 | 预检的权重文件 |
| --- | --- | --- |
| `models/whisper-large-v3-turbo/` | WebGPU，`q4f16` | `onnx/encoder_model_q4f16.onnx`、`onnx/decoder_model_merged_q4f16.onnx` |
| `models/whisper-small/` | WASM，`q8` | `onnx/encoder_model_quantized.onnx`、`onnx/decoder_model_merged_quantized.onnx` |

模型文件必须与同目录的 `config.json`、processor、tokenizer 和 generation config 属于相容的模型导出。若导出使用 ONNX 外部数据文件，也必须按原始相对路径提供这些配套文件。不要只把不同模型的文件改名来通过预检。

预检先确认本机主权重存在，再在下载 B 站音频前初始化模型；初始化会进一步暴露缺少配套文件、运行时不相容或 GPU 不可用等错误。仅通过文件存在检查不能证明模型有效或转录正确。

程序优先尝试可用的 WebGPU 模型，随后尝试 WASM 模型。模型加载设置 `allowRemoteModels = false`，并使用 `local_files_only`；不会因为本地缺少文件而默默改为远端模型下载。

## 目前限制

- 转写最多 60 分钟的影片；这不是既有字幕下载的时长限制。
- 本次仓库回归测试使用模拟推理结果，验证完整、部分失败和全部失败的控制流程，未宣称真实 Whisper 准确率、速度或 GPU 相容性已经通过验收。
- 部分转写不会计入完整成功；保留已取得文字，并附失败区块、缺失区间和部分结果警示。
- 音频仍需从 B 站及其影音 CDN 获取，本地推理不代表全程离线。

在完整模型组合与目标设备尚未实际验收前，建议先使用既有字幕擷取功能。后续真实模型验证应记录模型来源/版本/校验值、浏览器与设备，以及音频来源和转写完整性。
