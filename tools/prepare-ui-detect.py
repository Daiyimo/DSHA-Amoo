#!/usr/bin/env python3
"""准备 ui-detect 运行时资产：下载并校验锁定的 cp314/aarch64 wheel 到插件资产目录。

产物: app/src/main/assets/ui-detect/wheels/*.whl（8 个，覆盖 onnxruntime 依赖闭包）。
这些 wheel 与 ui_detect.py、yolov8n-ui.onnx 一起经 managed-runtime-inputs.json 的 installs
装进容器 /root/.dsha/ui-detect/；MCP server 首次 detect 时用它们离线 pip 自建 site，无需网络。

ui_detect.py 与 yolov8n-ui.onnx 是源/导出产物，不在此脚本生成（见 tools/export-ui-onnx.py）。
用法: python -I tools/prepare-ui-detect.py
"""
import hashlib
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WHEELS = ROOT / "app/src/main/assets/ui-detect/wheels"

# (filename, url, sha256) —— 版本与摘要锁定，重下即复现；换版本需重新核验。
WHEEL_LOCK = [
    ("onnxruntime-1.24.1-cp312-cp312-manylinux_2_27_aarch64.manylinux_2_28_aarch64.whl",
     "https://files.pythonhosted.org/packages/21/60/004401cd86525101ad8aa9eec301327426555d7a77fac89fd991c3c7aae6/onnxruntime-1.24.1-cp312-cp312-manylinux_2_27_aarch64.manylinux_2_28_aarch64.whl",
     "780add442ce2d4175fafb6f3102cdc94243acffa3ab16eacc03dd627cc7b1b54"),
    ("numpy-2.3.2-cp312-cp312-manylinux_2_27_aarch64.manylinux_2_28_aarch64.whl",
     "https://files.pythonhosted.org/packages/91/ba/f4ebf257f08affa464fe6036e13f2bf9d4642a40228781dc1235da81be9f/numpy-2.3.2-cp312-cp312-manylinux_2_27_aarch64.manylinux_2_28_aarch64.whl",
     "572d5512df5470f50ada8d1972c5f1082d9a0b7aa5944db8084077570cf98370"),
    ("pillow-11.3.0-cp312-cp312-manylinux2014_aarch64.manylinux_2_17_aarch64.whl",
     "https://files.pythonhosted.org/packages/8e/1e/b9e12bbe6e4c2220effebc09ea0923a07a6da1e1f1bfbc8d7d29a01ce32b/pillow-11.3.0-cp312-cp312-manylinux2014_aarch64.manylinux_2_17_aarch64.whl",
     "eb76541cba2f958032d79d143b98a3a6b3ea87f0959bbe256c0b5e416599fd5d"),
    ("flatbuffers-25.12.19-py2.py3-none-any.whl",
     "https://files.pythonhosted.org/packages/e8/2d/d2a548598be01649e2d46231d151a6c56d10b964d94043a335ae56ea2d92/flatbuffers-25.12.19-py2.py3-none-any.whl",
     "7634f50c427838bb021c2d66a3d1168e9d199b0607e6329399f04846d42e20b4"),
    ("packaging-26.3-py3-none-any.whl",
     "https://files.pythonhosted.org/packages/63/34/ba1c580383c9eada3711951fef0795c80b829a078d72188184bcab9dd527/packaging-26.3-py3-none-any.whl",
     "d7193f7c8e4e93f444fde0262bf90af30e16fa0ad0ad44cb553c87339b23cd1c"),
    ("protobuf-7.36.2-cp310-abi3-manylinux2014_aarch64.whl",
     "https://files.pythonhosted.org/packages/b6/ea/91fdf7c2b8bbd49cde056f00a9df6773532987e1c00fe2830b895af95c7e/protobuf-7.36.2-cp310-abi3-manylinux2014_aarch64.whl",
     "e11e1f0180583a2af89db6a2ecd9e8dc40aa6d2988ca175bfd0e6d12ea72d74e"),
    ("sympy-1.14.0-py3-none-any.whl",
     "https://files.pythonhosted.org/packages/a2/09/77d55d46fd61b4a135c444fc97158ef34a095e5681d0a6c10b75bf356191/sympy-1.14.0-py3-none-any.whl",
     "e091cc3e99d2141a0ba2847328f5479b05d94a6635cb96148ccb3f34671bd8f5"),
    ("mpmath-1.3.0-py3-none-any.whl",
     "https://files.pythonhosted.org/packages/43/e3/7d92a15f894aa0c9c4b49b8ee9ac9850d6e63b03c9c32c0367a13ae62209/mpmath-1.3.0-py3-none-any.whl",
     "a0b2b9fe80bbcd81a6647ff13108738cfb482d481d826cc0e02f5b35e5c88d2c"),
]


def sha256_file(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main():
    WHEELS.mkdir(parents=True, exist_ok=True)
    for name, url, sha in WHEEL_LOCK:
        target = WHEELS / name
        if not target.is_file() or sha256_file(target) != sha:
            data = urllib.request.urlopen(url, timeout=180).read()
            if hashlib.sha256(data).hexdigest() != sha:
                raise SystemExit("wheel 摘要不符：" + name)
            target.write_bytes(data)
        print("ready", name)
    print("ui-detect wheels ready:", WHEELS)
    return 0


if __name__ == "__main__":
    sys.exit(main())
