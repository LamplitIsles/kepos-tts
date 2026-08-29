export const RPC_CHANNEL = "/kepos-tts";
export const RPC_ENDPOINT = "synthesize";

export interface BrowserAudioPayload {
  mediaType: "audio/mpeg";
  data: string;
  bytes: number;
}
