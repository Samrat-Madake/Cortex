import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import {
  buildConfigSetArgs,
  configSetValue,
  defaultLlmModel,
  defaultVlmModelLite,
  looksLikeNonDefaultEmbedder,
  mustUseIndependentEmbedder,
  parsePositiveIntegerInput,
  type ConfigureAnswers,
} from "./configure-plan.js";

export interface ConfigurePrompter {
  ask(question: string): Promise<string>;
  close(): void;
}

function createReadlinePrompter(): ConfigurePrompter {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return {
    ask(question) {
      return new Promise((resolve) => {
        rl.question(question, (answer) => {
          resolve(answer.trim());
        });
      });
    },
    close() {
      rl.close();
    },
  };
}

export function createPipedPrompter(input: string, output: Pick<NodeJS.WriteStream, "write"> = process.stdout): ConfigurePrompter {
  const lines = input.replace(/\r\n/g, "\n").split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  let index = 0;
  return {
    async ask(question) {
      output.write(question);
      if (index >= lines.length) {
        throw new Error(`No piped answer available for prompt: ${question.trim()}`);
      }
      const answer = lines[index]!;
      index += 1;
      return answer.trim();
    },
    close() { /* no-op */ },
  };
}

function createConfigurePrompter(): ConfigurePrompter {
  if (process.stdin.isTTY) return createReadlinePrompter();
  return createPipedPrompter(readFileSync(0, "utf8"));
}

function ask(prompter: ConfigurePrompter, question: string): Promise<string> {
  return prompter.ask(question);
}

async function askDefault(prompter: ConfigurePrompter, question: string, fallback: string): Promise<string> {
  const answer = await ask(prompter, `${question} (${fallback}): `);
  return answer || fallback;
}

async function askRequired(prompter: ConfigurePrompter, question: string): Promise<string> {
  for (;;) {
    const answer = await ask(prompter, `${question}: `);
    if (answer) return answer;
    console.log("  Required. Please enter a value.");
  }
}

async function askChoice<T extends string>(prompter: ConfigurePrompter, question: string, choices: readonly T[], fallback: T): Promise<T> {
  const label = choices.join("/");
  for (;;) {
    const answer = (await ask(prompter, `${question} [${label}] (${fallback}): `)) || fallback;
    if ((choices as readonly string[]).includes(answer)) return answer as T;
    console.log(`  Choose one of: ${label}`);
  }
}

function runOpenClaw(args: string[], options: { stdio?: "inherit" | "pipe" } = {}): string {
  if (options.stdio === "inherit") {
    execFileSync("openclaw", args, { stdio: "inherit" });
    return "";
  }
  return execFileSync("openclaw", args, { encoding: "utf8" });
}

function checkOpenClawAvailable(): void {
  try {
    runOpenClaw(["config", "file"]);
  } catch {
    throw new Error("OpenClaw CLI is not available or `openclaw config file` failed. Install/configure OpenClaw first.");
  }
}

export async function collectConfigureAnswers(prompter: ConfigurePrompter): Promise<ConfigureAnswers> {
  const vlmProvider = await askChoice(prompter, "VLM provider", ["openai", "gemini"] as const, "openai");
  const vlmModel = await askRequired(prompter, "VLM model (must be vision-capable)");
  const vlmModelLite = await askDefault(prompter, "VLM lite model (snapshot/single-frame)", defaultVlmModelLite(vlmProvider, vlmModel));
  const vlmApiKey = await askRequired(prompter, "VLM API key");
  const defaultBaseUrl = vlmProvider === "openai" ? "https://api.openai.com/v1" : "";
  const vlmBaseUrl = defaultBaseUrl
    ? await askDefault(prompter, "VLM base URL", defaultBaseUrl)
    : await ask(prompter, "VLM base URL (optional for gemini): ");
  const llmModel = await askDefault(prompter, "LLM model (text compression/narrative)", defaultLlmModel(vlmProvider, vlmModel));

  let embedderSameGateway = false;
  if (mustUseIndependentEmbedder(vlmProvider)) {
    console.log("Gemini does not provide the OpenAI-compatible embeddings endpoint used by ReflectWorld memory; configure an independent embedder.");
  } else {
    const embedderAnswer = await askChoice(prompter, "Embedder uses same gateway + default text-embedding-3-small?", ["y", "n"] as const, "y");
    embedderSameGateway = embedderAnswer === "y";
  }

  const answers: ConfigureAnswers = {
    vlm_provider: vlmProvider,
    vlm_model: vlmModel,
    vlm_model_lite: vlmModelLite,
    vlm_api_key: vlmApiKey,
    vlm_base_url: vlmBaseUrl,
    llm_model: llmModel,
    embedderSameGateway,
    stt: "off",
  };

  if (!embedderSameGateway) {
    answers.embedder_provider = await askChoice(prompter, "Embedder provider", ["openai"] as const, "openai");
    answers.embedder_model = await askDefault(prompter, "Embedder model", "text-embedding-3-small");
    answers.embedder_api_key = await askRequired(prompter, "Embedder API key");
    answers.embedder_base_url = answers.embedder_provider === "openai"
      ? await askDefault(prompter, "Embedder base URL", "https://api.openai.com/v1")
      : await ask(prompter, "Embedder base URL (optional): ");
    const dimsRaw = await askDefault(prompter, "Embedding dims", "1536");
    answers.embedding_dims = parsePositiveIntegerInput(dimsRaw, "embedding dims");
    if (looksLikeNonDefaultEmbedder(answers.embedder_model, answers.embedding_dims)) {
      answers.collection_name = await askRequired(prompter, "New memory collection_name for this embedder/dims");
    }
  }

  const stt = await askChoice(prompter, "Speech-to-text", ["off", "moonshine", "elevenlabs"] as const, "off");
  answers.stt = stt;
  if (stt === "moonshine") {
    const modelDir = await askRequired(prompter, "MoonShine model directory");
    if (!existsSync(modelDir)) {
      throw new Error(`MoonShine model directory not found: ${modelDir}. Run setup or provide a valid stt_model_dir.`);
    }
    answers.stt_model_dir = modelDir;
  } else if (stt === "elevenlabs") {
    answers.elevenlabs_api_key = await askRequired(prompter, "ElevenLabs API key");
  }

  return answers;
}

type OpenClawRunner = (args: string[], options?: { stdio?: "inherit" | "pipe" }) => string;

export function restartOpenClawGateway(run: OpenClawRunner = runOpenClaw): boolean {
  try {
    run(["gateway", "restart"], { stdio: "inherit" });
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn("\nOpenClaw gateway restart did not complete.");
    console.warn("This is expected when the gateway was started manually instead of through a managed service.");
    console.warn("Restart the OpenClaw gateway process manually for the new ReflectWorld config to take effect.");
    console.warn(`Restart error: ${message}\n`);
    return false;
  }
}

export async function runConfigure(_args: string[]): Promise<void> {
  console.log("\nReflectWorld OpenClaw Configuration\n");
  checkOpenClawAvailable();

  const prompter = createConfigurePrompter();
  try {
    const answers = await collectConfigureAnswers(prompter);
    const commands = buildConfigSetArgs(answers);
    console.log(`\nWriting ${commands.length} config value(s)...`);
    for (const [path, value] of commands) {
      runOpenClaw(["config", "set", path, configSetValue(path, value)], { stdio: "inherit" });
    }

    console.log("\nValidating OpenClaw config...");
    runOpenClaw(["config", "validate"], { stdio: "inherit" });

    console.log("\nRestarting OpenClaw gateway...");
    restartOpenClawGateway();

    console.log("\nReflectWorld OpenClaw configuration complete.\n");
  } finally {
    prompter.close();
  }
}
