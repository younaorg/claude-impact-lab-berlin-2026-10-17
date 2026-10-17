// Person 2 — Whisper. See worksplit.md Role 2.
// POST multipart/form-data, field name "audio" → { text: string }
// GET → { provider: "elevenlabs" | "whisper" | null }, so TalkButton knows
// whether to record for the server or fall back to browser speech recognition.
//
// Speech-to-text provider: ElevenLabs Scribe when ELEVENLABS_API_KEY is set,
// otherwise OpenAI Whisper with OPENAI_API_KEY. The response shape is the same.

const MAX_BYTES = 10 * 1024 * 1024;

const NO_RECORDING = "No recording came through.";
const NOT_CAUGHT = "I didn’t catch that. Hold the button and say it once more.";
const NO_SERVICE = "Voice isn’t set up on this server yet. You can type the sentence below.";
const SERVICE_DOWN = "The voice service isn’t answering right now. You can type the sentence below.";

function fail(error: string, status: number) {
  return Response.json({ error }, { status });
}

function provider() {
  if (process.env.ELEVENLABS_API_KEY) return "elevenlabs" as const;
  if (process.env.OPENAI_API_KEY) return "whisper" as const;
  return null;
}

// Whisper and ElevenLabs read the format from the file name, so make sure it has one.
function fileName(type: string) {
  if (type.includes("mp4") || type.includes("m4a")) return "recording.mp4";
  if (type.includes("ogg")) return "recording.ogg";
  if (type.includes("wav")) return "recording.wav";
  if (type.includes("mpeg") || type.includes("mp3")) return "recording.mp3";
  return "recording.webm";
}

async function transcribeWithElevenLabs(audio: Blob, name: string, apiKey: string) {
  const body = new FormData();
  body.append("file", audio, name);
  body.append("model_id", "scribe_v2");
  // No language_code: English and German are both detected.

  const res = await fetch("https://api.elevenlabs.io/v1/speech-to-text", {
    method: "POST",
    headers: { "xi-api-key": apiKey },
    body,
  });
  if (!res.ok) {
    console.error("ElevenLabs speech-to-text failed", res.status, (await res.text()).slice(0, 200));
    return null;
  }
  const data = (await res.json()) as { text?: string };
  return data.text ?? "";
}

async function transcribeWithWhisper(audio: Blob, name: string, apiKey: string) {
  const body = new FormData();
  body.append("file", audio, name);
  body.append("model", "whisper-1");
  body.append("response_format", "text");
  // No language: English and German are both detected.

  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body,
  });
  if (!res.ok) {
    console.error("Whisper transcription failed", res.status, (await res.text()).slice(0, 200));
    return null;
  }
  return res.text();
}

export async function GET() {
  return Response.json({ provider: provider() });
}

export async function POST(request: Request) {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return fail(NO_RECORDING, 400);
  }

  const audio = form.get("audio");
  if (!(audio instanceof Blob) || audio.size === 0 || audio.size > MAX_BYTES) {
    return fail(NO_RECORDING, 400);
  }

  const which = provider();
  if (!which) return fail(NO_SERVICE, 500);

  const name = fileName(audio.type);
  let text: string | null;
  try {
    text =
      which === "elevenlabs"
        ? await transcribeWithElevenLabs(audio, name, process.env.ELEVENLABS_API_KEY ?? "")
        : await transcribeWithWhisper(audio, name, process.env.OPENAI_API_KEY ?? "");
  } catch (err) {
    console.error("Speech-to-text request threw", err instanceof Error ? err.message : "error");
    text = null;
  }

  if (text === null) return fail(SERVICE_DOWN, 502);

  const trimmed = text.trim();
  if (!trimmed) return fail(NOT_CAUGHT, 502);

  return Response.json({ text: trimmed });
}
