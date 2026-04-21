import { Show } from "solid-js"
import { t } from "../i18n"
import { useLicense } from "./use-license"

export function TrialBanner(props: { onUpgrade: () => void }) {
  const lic = useLicense().license
  return (
    <Show
      when={
        lic()?.effectiveStatus === "trial" &&
        typeof lic()?.trialDaysRemaining === "number" &&
        lic()!.trialDaysRemaining! <= 1
      }
    >
      <div data-component="trial-banner">
        <span>{t("subscription.banner.endingSoon", { days: String(lic()?.trialDaysRemaining ?? 0) })}</span>
        <button onClick={props.onUpgrade}>{t("subscription.banner.upgrade")}</button>
      </div>
    </Show>
  )
}
