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

## Usage

In any note, select the ribbon icon or the command palette 'Toggle Voice Transcription' command to start transcribing. Select it again to stop. The audio is not saved except briefly on desktop platforms to perform the transcription.

## Transcribing audio files embedded in a note

Notes that embed audio files (e.g. `![[Recording.m4a]]`, supporting `mp3, wav, m4a, ogg, 3gp, flac, webm`) can have those files transcribed directly, with the transcript inserted below the embed:

- Click the **Transcribe** button next to the embedded audio player (Live Preview and Reading view).
- Right-click the embedded audio player and choose **Transcribe**.
- Run the command **Transcribe audio in this note**, or click the audio-file ribbon icon in the sidebar, and pick a file from the list of audio files linked in the current note.

The transcript is written under a `Transcription` heading (level configurable in settings, default `##`). Transcribing an already-transcribed embed asks before replacing. The same Whisper model and regex filter settings used for live transcription are applied, and the same engines are used: whisper.cpp on desktop, transformers.js on mobile.

## Privacy

This plugin processes all audio data locally on your device. No audio recordings or transcriptions are transmitted to external servers at any point.

## Sources

On the desktop, this plugin will install an executable from one of these locations:

- https://github.com/ggerganov/whisper.cpp/releases/latest

- https://github.com/bizenlabs/whisper-cpp-macos-bin/releases/latest

- https://github.com/dscripka/whisper.cpp_binaries/releases/latest

Both the desktop and mobile versions fetch models from huggingface:

- (Desktop) https://huggingface.co/ggerganov/whisper.cpp

- (Mobile) https://huggingface.co/Xenova
