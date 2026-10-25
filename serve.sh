#!/bin/sh
# 本地预览：语音识别（Web Speech API）要求 localhost / https 来源，所以别直接双击 index.html。
cd "$(dirname "$0")" && echo "打开 http://localhost:8765/  （Chrome / Edge，允许麦克风）" && python3 -m http.server 8765
