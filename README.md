# Obsidian Offline Whisper Transcription

Offline speech-to-text using Whisper

## Overview

This plugin provides speech-to-text transcription for Obsidian using Whisper models. It is designed to function entirely offline after the initial model download. It supports both desktop and mobile environments.

## Platform Implementation

The plugin uses different underlying engines to ensure performance and compatibility across devices.

On desktop operating systems (Windows, MacOS, Linux), the plugin utilizes `whisper.cpp`. One first use, the appropriate `whisper.cpp` command-line binary is downloaded for the operating system.

On mobile operating systems (Android, iOS), the plugin utilizes a bundled version of transformers.js that runs via WebAssembly. Both the transcription model and the optional text cleanup model run in a web worker, so inference never blocks the editor's main thread.

## Model Selection

Navigate to the plugin settings to select a model. Models are downloaded from Hugging Face on first use. The larger the model, the slower it is. On the tested devices, the "base" model works on mobile devices and the "small" model works on desktop devices. It is recommended that you choose the largest model that can keep up with transcribing speech.

## Transcription Speed

The plugin measures how long each transcription takes relative to the length of its audio, over the ten most recent chunks. The "Transcription speed" entry on the settings page reports this ratio and what it means: a ratio above 1 second of transcription per second of audio means the model cannot keep up with speech and the transcription queue will grow while recording, so a smaller, faster model would be advised. A ratio well below 1 suggests a larger, more accurate model may still keep up. Record some audio, then reopen the settings to see the current measurement.

## Text Cleanup

Whisper transcription often contains artifacts: repeated words or phrases ("word whiskers"), hallucinated text during silence, and inconsistent capitalization or punctuation. The optional "Clean up transcription text" setting (desktop only) runs each transcribed chunk through a small local language model before it is inserted into the note. The model removes some artifacts.

This setting is off by default because a language model can occasionally alter text in unfortunate ways. The cleanup result is only used when it is plausible: if the model produces nothing usable, produces text much longer than the input, or produces text that shares no vocabulary with the transcription, the raw transcription is inserted unchanged. If the cleanup engine cannot be started, recording proceeds with unprocessed text.

All downloads come from Hugging Face and GitHub and are stored inside the plugin's directory; after the first download, everything runs entirely offline.

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
