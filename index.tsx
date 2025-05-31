/* tslint:disable */
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import {GoogleGenAI, LiveServerMessage, Modality, Session, ConnectRequestConfig} from '@google/genai';
import {LitElement, css, html} from 'lit';
import {customElement, state} from 'lit/decorators.js';
import {createBlob, decode, decodeAudioData} from './utils';
import './visual-3d';

@customElement('gdm-live-audio')
export class GdmLiveAudio extends LitElement {
  @state() isRecording = false;
  @state() status = '';
  @state() error = '';
  @state() private sessionActive = false;

  private client: GoogleGenAI;
  private session: Session;
  private inputAudioContext = new (window.AudioContext ||
    (window as any).webkitAudioContext)({sampleRate: 16000});
  private outputAudioContext = new (window.AudioContext ||
    (window as any).webkitAudioContext)({sampleRate: 24000});
  @state() inputNode = this.inputAudioContext.createGain();
  @state() outputNode = this.outputAudioContext.createGain();
  private nextStartTime = 0;
  private mediaStream: MediaStream;
  private sourceNode: AudioBufferSourceNode;
  private scriptProcessorNode: ScriptProcessorNode;
  private sources = new Set<AudioBufferSourceNode>();

  static styles = css`
    #status {
      position: absolute;
      bottom: 5vh;
      left: 0;
      right: 0;
      z-index: 10;
      text-align: center;
      color: white; /* Added for better visibility */
      font-family: sans-serif; /* Added for better readability */
    }

    .controls {
      z-index: 10;
      position: absolute;
      bottom: 10vh;
      left: 0;
      right: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-direction: column;
      gap: 10px;

      button {
        outline: none;
        border: 1px solid rgba(255, 255, 255, 0.2);
        color: white;
        border-radius: 12px;
        background: rgba(255, 255, 255, 0.1);
        width: 64px;
        height: 64px;
        cursor: pointer;
        font-size: 24px;
        padding: 0;
        margin: 0;
        display: flex; /* Added for icon centering */
        align-items: center; /* Added for icon centering */
        justify-content: center; /* Added for icon centering */

        &:hover {
          background: rgba(255, 255, 255, 0.2);
        }
      }

      button[disabled] {
        /* display: none; */ /* Commented out to keep consistent layout */
        opacity: 0.5;
        cursor: not-allowed;
      }
      /* Styling for buttons that should be hidden when disabled */
      button#startButton[disabled], button#resetButton[disabled] {
        display: none;
      }
      button#stopButton:not([disabled]) + button#startButton,
      button#resetButton:not([disabled]) + button#startButton {
         /* Ensures start button is shown if stop/reset is not disabled */
      }
      button#stopButton[disabled] {
         display: none;
      }


    }
  `;

  constructor() {
    super();
    this.initClient();
  }

  private initAudio() {
    this.nextStartTime = this.outputAudioContext.currentTime;
  }

  private async initClient() {
    this.initAudio();

    this.client = new GoogleGenAI({
      apiKey: process.env.API_KEY, // Updated API key variable
    });

    this.outputNode.connect(this.outputAudioContext.destination);

    this.initSession();
  }

  private async initSession() {
    this.sessionActive = false; // Reset session state
    const model = 'gemini-2.5-flash-preview-native-audio-dialog';
    let systemInstructionContent: string | undefined = undefined;

    try {
      const response = await fetch('metadata.json');
      if (response.ok) {
        const metadata = await response.json();
        if (metadata && metadata.prompt && typeof metadata.prompt === 'string' && metadata.prompt.trim() !== '') {
          systemInstructionContent = metadata.prompt.trim();
        }
      } else {
        console.warn('Could not fetch metadata.json. Proceeding without system prompt from metadata.');
        this.updateStatus('Warning: Could not load custom prompt.');
      }
    } catch (e) {
      console.error('Error fetching or parsing metadata.json:', e);
      this.updateError('Error loading custom prompt.');
    }

    const sessionConfig: ConnectRequestConfig = {
      responseModalities: [Modality.AUDIO],
      speechConfig: {voiceConfig: {prebuiltVoiceConfig: {voiceName: 'Orus'}}},
    };

    if (systemInstructionContent) {
      sessionConfig.systemInstruction = systemInstructionContent;
    }

    try {
      this.session = await this.client.live.connect({
        model: model,
        callbacks: {
          onopen: () => {
            this.sessionActive = true;
            this.updateStatus('Connected. Ready to chat!');
          },
          onmessage: async (message: LiveServerMessage) => {
            const audio =
              message.serverContent?.modelTurn?.parts[0]?.inlineData;

            if (audio) {
              this.nextStartTime = Math.max(
                this.nextStartTime,
                this.outputAudioContext.currentTime,
              );

              const audioBuffer = await decodeAudioData(
                decode(audio.data),
                this.outputAudioContext,
                24000,
                1,
              );
              const source = this.outputAudioContext.createBufferSource();
              source.buffer = audioBuffer;
              source.connect(this.outputNode);
              source.addEventListener('ended', () =>{
                this.sources.delete(source);
              });

              source.start(this.nextStartTime);
              this.nextStartTime = this.nextStartTime + audioBuffer.duration;
              this.sources.add(source);
            }

            const interrupted = message.serverContent?.interrupted;
            if(interrupted) {
              for(const source of this.sources.values()) {
                source.stop();
                this.sources.delete(source);
              }
              this.nextStartTime = 0;
            }
          },
          onerror: (e: ErrorEvent) => {
            this.sessionActive = false;
            this.updateError(`Error: ${e.message}`);
          },
          onclose: (e: CloseEvent) => {
            this.sessionActive = false;
            this.updateStatus(`Disconnected: ${e.reason || 'Connection closed'}`);
          },
        },
        config: sessionConfig,
      });
    } catch (e) {
      console.error('Error initializing session:', e);
      this.updateError(`Failed to initialize session: ${e.message}`);
    }
  }

  private updateStatus(msg: string) {
    this.status = msg;
    this.error = ''; // Clear error when status updates
  }

  private updateError(msg: string) {
    this.error = msg;
    this.status = ''; // Clear status when error updates
  }

  private async startRecording() {
    if (this.isRecording) {
      return;
    }

    // Re-initialize session if it's closed or not active
    if (!this.session || !this.sessionActive) {
        this.updateStatus('Re-initializing session...');
        await this.initSession();
        // Wait a bit for session to potentially open
        await new Promise(resolve => setTimeout(resolve, 500));
        if (!this.session || !this.sessionActive) {
            this.updateError('Failed to re-initialize session. Please reset.');
            return;
        }
    }


    this.inputAudioContext.resume();
    this.outputAudioContext.resume(); // Ensure output context is resumed

    this.updateStatus('Requesting microphone access...');
    this.error = '';


    try {
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
            sampleRate: 16000, // Specify sample rate for input
            channelCount: 1,    // Specify mono channel
        },
        video: false,
      });

      this.updateStatus('Microphone access granted. Starting capture...');

      this.sourceNode = this.inputAudioContext.createMediaStreamSource(
        this.mediaStream,
      );
      this.sourceNode.connect(this.inputNode);

      const bufferSize = 4096; // Standard buffer size
      this.scriptProcessorNode = this.inputAudioContext.createScriptProcessor(
        bufferSize,
        1,
        1,
      );

      this.scriptProcessorNode.onaudioprocess = (audioProcessingEvent) => {
        if (!this.isRecording || !this.session || !this.sessionActive) return;

        const inputBuffer = audioProcessingEvent.inputBuffer;
        const pcmData = inputBuffer.getChannelData(0);

        try {
            if (this.session && this.sessionActive) {
                 this.session.sendRealtimeInput({media: createBlob(pcmData)});
            }
        } catch (err) {
            console.error('Error sending audio data:', err);
            // Consider stopping recording or attempting to re-initialize session
            // For now, just log and potentially update UI
            // this.updateError('Error sending audio. Try resetting.');
            // this.stopRecording();
        }
      };

      this.sourceNode.connect(this.scriptProcessorNode);
      // It's generally not recommended to connect scriptProcessorNode to destination
      // if you don't want to hear the raw input.
      // this.scriptProcessorNode.connect(this.inputAudioContext.destination);
      // If you need to process it without hearing, connect to a dummy GainNode:
      const dummyGain = this.inputAudioContext.createGain();
      dummyGain.gain.value = 0;
      this.scriptProcessorNode.connect(dummyGain);
      dummyGain.connect(this.inputAudioContext.destination);


      this.isRecording = true;
      this.updateStatus('🔴 Recording... Speak now!');
    } catch (err) {
      console.error('Error starting recording:', err);
      this.updateError(`Error starting recording: ${err.message}. Please ensure microphone permission is granted.`);
      this.stopRecording(); // Clean up
    }
  }

  private stopRecording() {
    if (!this.isRecording && !this.mediaStream && !this.inputAudioContext) {
      // No active recording or resources to stop
      if (this.isRecording) this.isRecording = false; // Ensure state is correct
      return;
    }


    this.updateStatus('Stopping recording...');
    this.isRecording = false; // Set recording state to false immediately

    if (this.scriptProcessorNode) {
        this.scriptProcessorNode.onaudioprocess = null; // Remove the handler
        this.scriptProcessorNode.disconnect();
        this.scriptProcessorNode = null;
    }

    if (this.sourceNode) {
        this.sourceNode.disconnect();
        this.sourceNode = null;
    }

    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((track) => track.stop());
      this.mediaStream = null;
    }

    // Do not suspend inputAudioContext, as it might be needed for re-starting
    // or for other components. Let it be managed by its lifecycle.

    this.updateStatus('🔴 Recording stopped. Click Start to chat again.');
  }

  private async reset() {
    this.stopRecording(); // Ensure any active recording is stopped first
    this.updateStatus('Resetting session...');
    if (this.session && this.sessionActive) {
      try {
        // Calling close will trigger onclose callback, which sets sessionActive = false
        await this.session.close();
      } catch (e) {
        console.warn('Error closing existing session during reset:', e);
        this.sessionActive = false; // Ensure state is updated even if close throws
      }
    }
    this.sources.forEach(source => source.stop());
    this.sources.clear();
    this.nextStartTime = 0;

    // Re-initialize audio contexts if they were closed or suspended
    if (this.inputAudioContext.state === 'suspended') {
        this.inputAudioContext.resume();
    }
    if (this.outputAudioContext.state === 'suspended') {
        this.outputAudioContext.resume();
    }
    this.initAudio(); // Reset nextStartTime based on current audio time

    await this.initSession(); // Initialize a new session
    // Status update will be handled by initSession's onopen or onerror
  }

  render() {
    const showStartButton = !this.isRecording;
    const showStopButton = this.isRecording;
    const showResetButton = !this.isRecording; // Show reset only when not recording

    return html`
      <div>
        <div class="controls">
          <button
            id="resetButton"
            @click=${this.reset}
            ?disabled=${!showResetButton}
            title="Reset Session"
            aria-label="Reset Session">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              height="40px"
              viewBox="0 -960 960 960"
              width="40px"
              fill="currentColor">
              <path
                d="M480-160q-134 0-227-93t-93-227q0-134 93-227t227-93q69 0 132 28.5T720-690v-110h80v280H520v-80h168q-32-56-87.5-88T480-720q-100 0-170 70t-70 170q0 100 70 170t170 70q77 0 139-44t87-116h84q-28 106-114 173t-196 67Z" />
            </svg>
          </button>
          <button
            id="startButton"
            @click=${this.startRecording}
            ?disabled=${!showStartButton}
            title="Start Recording"
            aria-label="Start Recording">
            <svg
              viewBox="0 0 100 100"
              width="32px"
              height="32px"
              fill="#c80000"
              xmlns="http://www.w3.org/2000/svg">
              <circle cx="50" cy="50" r="50" />
            </svg>
          </button>
          <button
            id="stopButton"
            @click=${this.stopRecording}
            ?disabled=${!showStopButton}
            title="Stop Recording"
            aria-label="Stop Recording">
            <svg
              viewBox="0 0 100 100"
              width="32px"
              height="32px"
              fill="#000000"
              xmlns="http://www.w3.org/2000/svg">
              <rect x="0" y="0" width="100" height="100" rx="15" />
            </svg>
          </button>
        </div>

        <div id="status" role="status" aria-live="polite">
         ${this.error ? `Error: ${this.error}` : this.status}
        </div>
        <gdm-live-audio-visuals-3d
          .inputNode=${this.inputNode}
          .outputNode=${this.outputNode}></gdm-live-audio-visuals-3d>
      </div>
    `;
  }
}