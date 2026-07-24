import { NocAlert } from '@domain/entities/nocAlert';
import { NocAlertRepository } from '@domain/ports/NocAlertRepository';
import { AlertNotifier } from '@domain/ports/AlertNotifier';
import { FeatureFlagRepository } from '@domain/ports/FeatureFlagRepository';

/**
 * Same key the Fase A migration seeds `false` for (design.md "Flags de
 * convivencia") — reused here, NOT re-declared, so a typo can never drift the
 * flag this use-case reads from the one the seed/UI toggle write to.
 */
export const TELEGRAM_SEND_FLAG = 'noc-alerts-telegram-send';

/**
 * NotifyAlert — Fase D (`noc-alert-telegram`) outbound fan-out. Invoked as an
 * `AlertEventBus` subscriber (composeAlertsModule), NOT called directly by
 * `IngestAlert` — same "publish, then whoever's subscribed reacts" shape the
 * SSE route already uses (design.md Data Flow: `AlertEventPublisher(port)`
 * branches into BOTH the Telegram path, gated by the flag, and `AlertEventBus`
 * for SSE — they're peers off the same publish, not a call chain).
 *
 * spec.md "Outbound Telegram notification gated by feature flag": with the
 * flag OFF (default de convivencia), `AlertNotifier.notify` MUST NOT be
 * invoked under any circumstance — checked FIRST, before touching the
 * notifier at all. Absence of the flag row (never seeded/toggled) is treated
 * as OFF (`?? false`) — the OPPOSITE default from `noc-alerts-hub-enabled`
 * (`?? true` there): that flag existing-but-missing means "don't break an
 * already-dark-launched hub", this one missing means "stay dark, Telegram is
 * opt-in only via an explicit ON".
 */
export class NotifyAlert {
  constructor(
    private readonly repo: NocAlertRepository,
    private readonly notifier: AlertNotifier,
    private readonly featureFlagRepo: FeatureFlagRepository,
  ) {}

  async execute(alert: NocAlert): Promise<void> {
    const flag = await this.featureFlagRepo.get(TELEGRAM_SEND_FLAG);
    if (!(flag?.enabled ?? false)) return;

    // F-D1 (fix wave, HIGH) — `IngestAlert` publishes 'firing' on EVERY upsert
    // for the same (source, fingerprint), not just the first one (Grafana
    // re-evaluates, the fiber sensor re-posts every ~30min for the same
    // incident — see computeNocAlertIngest's "upsert in place" rule). Without
    // this guard, each re-fire sent a BRAND NEW Telegram message and
    // clobbered the stored messageId — spam at every re-evaluation cycle.
    // A NEW incident (resurrection, resolved→firing) gets a fresh notify:
    // computeNocAlertIngest resets these two fields to null on resurrection
    // (F-D2) specifically so this check does NOT block it.
    if (alert.telegramChatId && alert.telegramMessageId) return;

    const result = await this.notifier.notify(alert);
    if (result) {
      await this.repo.attachTelegramMessage(alert.id, result.chatId, result.messageId);
    }
  }
}
