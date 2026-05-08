import { Show, createMemo, createSignal, onMount } from "solid-js"
import { DateTime } from "luxon"
import { useNavigate } from "@solidjs/router"
import { useSync } from "@/context/sync"
import { useSDK } from "@/context/sdk"
import { useLanguage } from "@/context/language"
import { Icon } from "@opencode-ai/ui/icon"
import { Button } from "@opencode-ai/ui/button"
import { Mark } from "@opencode-ai/ui/logo"
import { showToast } from "@opencode-ai/ui/toast"
import { getDirectory, getFilename } from "@opencode-ai/util/path"
import { base64Encode } from "@opencode-ai/util/encode"

const MAIN_WORKTREE = "main"
const CREATE_WORKTREE = "create"
const ROOT_CLASS = "size-full flex flex-col"

interface NewSessionViewProps {
  worktree: string
}

// Starter template per AGENTS.md / .crimecoderules quando l'utente clicca
// "Crea regole progetto" e il file non esiste. Viene aperto nell'editor così
// l'utente può modificarlo subito invece di partire da pagina vuota.
const PROJECT_RULES_TEMPLATE = `# Project Rules

Queste regole vengono iniettate automaticamente nel system prompt dell'agente
ogni volta che lavori in questo progetto. L'agente le legge a inizio sessione
e le segue per tutta la conversazione.

## Coding style
- Use TypeScript strict mode
- Prefer composition over inheritance
- No comments unless explaining non-obvious "why"

## Stack & tooling
- Package manager: bun (not npm/yarn)
- Test framework: vitest
- Lint: prettier + eslint con config di progetto

## Project conventions
- File naming: kebab-case for files, PascalCase for components
- Commit style: conventional commits (feat:, fix:, refactor:, etc.)

<!-- Aggiungi/rimuovi regole sopra. L'agente le rispetterà automaticamente. -->
`

export function NewSessionView(props: NewSessionViewProps) {
  const sync = useSync()
  const sdk = useSDK()
  const language = useLanguage()
  const navigate = useNavigate()
  // Indica se uno dei file di rules (AGENTS.md / .crimecoderules / CRIMECODE.md /
  // CLAUDE.md) esiste nel project root. Aggiornato on mount + dopo create.
  const [rulesFile, setRulesFile] = createSignal<string | null | undefined>(undefined)
  const [busyRules, setBusyRules] = createSignal(false)

  const RULES_CANDIDATES = ["AGENTS.md", ".crimecoderules", "CRIMECODE.md", "CLAUDE.md"]

  const detectRulesFile = async () => {
    for (const name of RULES_CANDIDATES) {
      try {
        const res = await sdk.client.file.read({ path: name })
        // file.read returns { data: content } se file esiste, altrimenti error
        if (res?.data !== undefined && res.data !== null) {
          setRulesFile(name)
          return
        }
      } catch {
        /* file non esiste, continua */
      }
    }
    setRulesFile(null)
  }
  onMount(() => void detectRulesFile())

  const openOrCreateRules = async () => {
    setBusyRules(true)
    try {
      const existing = rulesFile()
      const targetName = existing ?? "AGENTS.md"
      if (!existing) {
        // Crea con template via PUT /file/content
        // SDK: il file.write accetta { path, content } in flat.
        try {
          await (sdk.client as any).file.write({
            path: targetName,
            content: PROJECT_RULES_TEMPLATE,
          })
          setRulesFile(targetName)
          showToast({
            variant: "success",
            title: `${targetName} creato`,
            description: "Modificalo per insegnare all'agente le regole del progetto.",
          })
        } catch (err) {
          showToast({
            variant: "error",
            title: "Creazione fallita",
            description: err instanceof Error ? err.message : "errore sconosciuto",
          })
          return
        }
      }
      // Apri il file in editor: navigate a /<dir>/file/<encodedPath>
      // Il routing lo apre come tab editor.
      const dirSlug = base64Encode(sdk.directory)
      navigate(`/${dirSlug}/file/${base64Encode(targetName)}`)
    } finally {
      setBusyRules(false)
    }
  }

  const sandboxes = createMemo(() => sync.project?.sandboxes ?? [])
  const options = createMemo(() => [MAIN_WORKTREE, ...sandboxes(), CREATE_WORKTREE])
  const current = createMemo(() => {
    const selection = props.worktree
    if (options().includes(selection)) return selection
    return MAIN_WORKTREE
  })
  const projectRoot = createMemo(() => sync.project?.worktree ?? sdk.directory)
  const isWorktree = createMemo(() => {
    const project = sync.project
    if (!project) return false
    return sdk.directory !== project.worktree
  })

  const label = (value: string) => {
    if (value === MAIN_WORKTREE) {
      if (isWorktree()) return language.t("session.new.worktree.main")
      const branch = sync.data.vcs?.branch
      if (branch) return language.t("session.new.worktree.mainWithBranch", { branch })
      return language.t("session.new.worktree.main")
    }

    if (value === CREATE_WORKTREE) return language.t("session.new.worktree.create")

    return getFilename(value)
  }

  return (
    <div class={ROOT_CLASS}>
      <div class="h-12 shrink-0" aria-hidden />
      <div class="flex-1 px-6 pb-30 flex items-center justify-center text-center">
        <div class="w-full max-w-200 flex flex-col items-center text-center gap-4">
          <div class="flex flex-col items-center gap-6">
            <Mark class="w-10" />
            <div class="text-20-medium text-text-strong">{language.t("session.new.title")}</div>
          </div>
          <div class="w-full flex flex-col gap-4 items-center">
            <div class="flex items-start justify-center gap-3 min-h-5">
              <div class="text-12-medium text-text-weak select-text leading-5 min-w-0 max-w-160 break-words text-center">
                {getDirectory(projectRoot())}
                <span class="text-text-strong">{getFilename(projectRoot())}</span>
              </div>
            </div>
            <div class="flex items-start justify-center gap-1.5 min-h-5">
              <Icon name="branch" size="small" class="mt-0.5 shrink-0" />
              <div class="text-12-medium text-text-weak select-text leading-5 min-w-0 max-w-160 break-words text-center">
                {label(current())}
              </div>
            </div>
            <Show when={sync.project}>
              {(project) => (
                <div class="flex items-start justify-center gap-3 min-h-5">
                  <div class="text-12-medium text-text-weak leading-5 min-w-0 max-w-160 break-words text-center">
                    {language.t("session.new.lastModified")}&nbsp;
                    <span class="text-text-strong">
                      {DateTime.fromMillis(project().time.updated ?? project().time.created)
                        .setLocale(language.intl())
                        .toRelative()}
                    </span>
                  </div>
                </div>
              )}
            </Show>
          </div>

          {/* Project Rules hint card — espone la feature AGENTS.md /
              .crimecoderules che la maggioranza degli utenti non sa esista.
              Stato: badge verde se file presente, ghost se assente.
              Click → apre o crea con template. */}
          <Show when={rulesFile() !== undefined}>
            <div class="mt-6 w-full max-w-100 flex flex-col items-stretch gap-2 px-4 py-3 rounded border border-surface-weak bg-surface-base">
              <div class="flex items-center gap-2">
                <Icon
                  name={rulesFile() ? "code-lines" : "code-lines"}
                  size="small"
                  class={rulesFile() ? "text-icon-success-base" : "text-text-weak"}
                />
                <Show
                  when={rulesFile()}
                  fallback={<span class="text-12-medium text-text-strong">Regole progetto persistenti</span>}
                >
                  <span class="text-12-medium text-text-strong">Regole progetto attive</span>
                  <span class="text-11-regular text-text-weak">
                    · {rulesFile()}
                  </span>
                </Show>
              </div>
              <p class="text-11-regular text-text-weak text-left leading-relaxed">
                <Show
                  when={rulesFile()}
                  fallback={
                    <>
                      Crea <code class="text-text-strong">AGENTS.md</code> nella root del progetto.
                      L'agente lo leggerà ad ogni sessione: stack, convenzioni di codice, preferenze.
                      Niente più ripetere "use TypeScript strict" ogni volta.
                    </>
                  }
                >
                  L'agente legge automaticamente questo file ad ogni sessione e ne segue le regole.
                </Show>
              </p>
              <Button
                size="small"
                variant={rulesFile() ? "secondary" : "primary"}
                onClick={openOrCreateRules}
                disabled={busyRules()}
              >
                {rulesFile() ? `Modifica ${rulesFile()}` : busyRules() ? "Creazione…" : "Crea AGENTS.md"}
              </Button>
            </div>
          </Show>
        </div>
      </div>
    </div>
  )
}
