import type { LoopPreset } from "../shared/app-rpc";
import { formatTelegramSessionLabel } from "./telegram-output";

export function getTelegramRemotePromptDeliveryMode(
  preset: LoopPreset | null,
): "once" | "persistent" {
  return preset === "await-reply" || preset === "passive" ? "once" : "persistent";
}

export function buildTelegramPromptReceivedText(input: {
  cwd?: string | null;
  sessionRef?: string | null;
  title?: string | null;
}) {
  const label = formatTelegramSessionLabel(input);
  return label.length > 0 ? `Received for ${label}.` : "Received.";
}

export function buildTelegramWorkingAckText(input: {
  cwd?: string | null;
  sessionRef?: string | null;
  title?: string | null;
}) {
  const label = formatTelegramSessionLabel(input);
  return label.length > 0 ? `Working on ${label}.` : "Working.";
}
