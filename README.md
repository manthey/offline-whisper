# Obsidian Offline Whisper Transcription

Offline speech-to-text using Whisper

## Overview

This plugin provides speech-to-text transcription for Obsidian using Whisper models. It is designed to function entirely offline after the initial model download. It supports both desktop and mobile environments.

## Platform Implementation

The plugin uses different underlying engines to ensure performance and compatibility across devices.

On desktop operating systems (Windows, MacOS, Linux), the plugin utilizes `whisper.cpp`. One first use, the appropriate `whisper.cpp` command-line binary is downloaded for the operating system.

On mobile operating systems (Android, iOS), the plugin utilizes a bundled version of transformers.js that runs via WebAssembly.

## Model Selection

Navigate to the plugin settings to select a model. Models are downloaded from Hugging Face on first use. The larger the model, the slower it is. On the tested devices, the "base" model works on mobile devices and the "small" model works on desktop devices. It is recommended that you choose the largest model that can keep up with transcribing speech.

## GPU Acceleration

The "Compute device" setting offers "GPU if available" as an opt-in alternative to the default CPU on Windows and on mobile devices.

On Windows, enabling it downloads a CUDA-enabled whisper binary (about 685MB) into a separate directory on first use and uses an NVIDIA GPU when one is present. If no usable GPU is available, or if the GPU transcription fails, transcription falls back to the CPU automatically. When multiple GPUs are present, whisper.cpp uses its default device.

On mobile devices, enabling it uses WebGPU when the browser provides it, falling back to the CPU (WebAssembly) automatically otherwise.

On macOS, transcription already uses Metal acceleration by default, and no setting is shown. On Linux, no GPU-enabled whisper binary is available for download, so no setting is shown.

## Usage

In any note, select the ribbon icon or the command palette 'Toggle Voice Transcription' command to start transcribing. Select it again to stop. The audio is not saved except briefly on desktop platforms to perform the transcription.

## Privacy

This plugin processes all audio data locally on your device. No audio recordings or transcriptions are transmitted to external servers at any point.

## Sources

On the desktop, this plugin will install an executable from one of these locations:

- https://github.com/ggml-org/whisper.cpp/releases/latest

- https://github.com/bizenlabs/whisper-cpp-macos-bin/releases/latest

- https://github.com/dscripka/whisper.cpp_binaries/releases/latest

Both the desktop and mobile versions fetch models from huggingface:

- (Desktop) https://huggingface.co/ggerganov/whisper.cpp

- (Mobile) https://huggingface.co/Xenova
