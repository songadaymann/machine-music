// content-safety.ts -- Claude Haiku classifier for human-submitted prompts
// Fail-open: if the API call fails or times out, the content is allowed through.

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const TIMEOUT_MS = 5_000;

export interface SafetyResult {
  safe: boolean;
  reason?: string;
  error?: string;
}

const SYSTEM_PROMPT = `You are a content safety classifier for a multiplayer music creation platform called SynthMob. Users can send text prompts to AI bot agents that create music, visuals, and 3D environments.

Classify the user message as SAFE or UNSAFE.

UNSAFE content includes:
- Explicit sexual content or solicitation
- Threats of violence against real people
- Hate speech targeting protected groups
- Instructions for illegal activities (drugs, weapons, hacking)
- Personal information (doxxing)
- Spam or scam content

SAFE content includes (even if edgy or unusual):
- Creative music directions ("make it sound dark and aggressive")
- Artistic references (horror, darkness, chaos themes)
- Playful trash talk between users
- Unusual or absurd creative requests
- Profanity used casually (not directed as hate speech)

Respond with exactly one line: SAFE or UNSAFE:<reason>`;

export async function checkContentSafety(content: string): Promise<SafetyResult> {
  if (!ANTHROPIC_API_KEY) {
    // No API key configured — fail open
    return { safe: true };
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

    const response = await fetch(ANTHROPIC_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 100,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content }],
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      // API error — fail open
      return { safe: true, error: `api_status_${response.status}` };
    }

    const data = (await response.json()) as {
      content?: Array<{ type: string; text?: string }>;
    };
    const text = data.content?.[0]?.text?.trim() || "";

    if (text.startsWith("UNSAFE")) {
      const reason = text.includes(":") ? text.split(":").slice(1).join(":").trim() : "flagged";
      return { safe: false, reason };
    }

    return { safe: true };
  } catch (err) {
    // Network error, timeout, etc. — fail open
    const message = err instanceof Error ? err.message : "unknown";
    return { safe: true, error: `exception_${message}` };
  }
}
