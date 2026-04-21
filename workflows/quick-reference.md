# Cybersecurity Toolkit - Quick Reference Card

## 📁 File Location

`C:\Users\mango\OneDrive\Desktop\opencode-main\workflows\`

---

## 🔧 TOOL COMMANDS (Copy-Paste Ready)

### Information Gathering

```
# WHOIS Lookup
/tool whois domain="target.com"

/# DNS Lookup completo
/tool dns_lookup domain="target.com" record_type="ALL"

/# SSL Certificate Check
/tool ssl_checker host="target.com" port=443

# Security Headers
/tool security_headers url="https://target.com"
```

### Network Tools

```
# Port Scanner
/tool port_scanner host="target.com" ports="22,80,443,3306,8080" timeout=5000

# Network Info
/tool network interface=""

/# DNS Lookup
/tool dns_lookup domain="example.com" record_type="A"
```

### Encoding & Hash

```
# URL Encode
/tool encoding text="<script>alert(1)</script>" action="url_encode"

# URL Decode
/tool encoding text="test%40gmail.com" action="url_decode"

# Base64 Encode
/tool encoding text="password" action="base64_encode"

# Base64 Decode
/tool encoding text="cGFzc3dvcmQ=" action="base64_decode"

# HTML Encode
/tool encoding text="<img src=x onerror=alert(1)>" action="html_encode"

# Hash MD5
/tool hash text="password" algorithm="md5"

# Hash SHA256
/tool hash text="password" algorithm="sha256"
```

### Security Analysis

```
# URL Analyzer
/tool url_analyzer url="https://target.com/redirect?url=https://evil.com"

# Security Headers
/tool security_headers url="https://target.com"

# Vulnerability Scanner
/tool vuln_scanner target="http://target.com" types="xss,sql,ssrf"
```

### Password & Wordlist

```
# Generate Strong Password
/tool password_generator length=32 include_special=true include_numbers=true

# Generate Wordlist
/tool wordlist pattern="admin,root,test" year=2024 common=true
```

### Utilities

```
# System Monitor
/tool system_monitor

# Battery Status
/tool battery

# Clipboard
/tool clipboard action="read"

# Unit Converter
/tool unit_converter value=100 from="mb" to="gb"
```

---

## 🎯 COMMON USAGE PATTERNS

### Bug Bounty

```
1. /tool whois domain="target.com"
2. /tool dns_lookup domain="target.com" record_type="ALL"
3. /tool port_scanner host="target.com" ports="80,443,8080"
4. /tool security_headers url="https://target.com"
5. /tool ssl_checker host="target.com" port=443
```

### CTF

```
1. Hash? → /tool hash text="plaintext" algorithm="MD5"
2. Encoded? → /tool encoding text="..." action="base64_decode"
3. URL encoded? → /tool encoding text="..." action="url_decode"
4. Suspicious URL? → /tool url_analyzer url="..."
```

### Pentest

```
1. Recon: whois, dns_lookup, port_scanner
2. SSL: ssl_checker, security_headers
3. Web: url_analyzer, vuln_scanner
4. Payloads: encoding (url_encode, html_encode)
5. Creds: hash, password_generator, wordlist
```

---

## ⚡ ONE-LINER CHEATSHEET

| Need        | Command                                                               |
| ----------- | --------------------------------------------------------------------- |
| IP lookup   | `/tool whois domain="target.com"`                                     |
| DNS records | `/tool dns_lookup domain="target.com" record_type="ALL"`              |
| SSL check   | `/tool ssl_checker host="target.com" port=443`                        |
| Port scan   | `/tool port_scanner host="target.com" ports="22,80,443"`              |
| XSS test    | `/tool encoding text="<script>alert(1)</script>" action="url_encode"` |
| SQLi test   | `/tool encoding text="' OR 1=1--" action="url_encode"`                |
| Hash verify | `/tool hash text="password" algorithm="md5"`                          |
| Pass gen    | `/tool password_generator length=16 special=true`                     |
| Wordlist    | `/tool wordlist pattern="admin" year=2024 common=true`                |

---

## 🛡️ SECURITY HEADERS CHECKLIST

```
□ Content-Security-Policy (CSP)
□ X-Frame-Options
□ X-Content-Type-Options
□ Strict-Transport-Security (HSTS)
□ X-XSS-Protection
□ Referrer-Policy
□ Permissions-Policy
```

---

## ⚠️ COMMON PAYLOADS

### XSS

```
<script>alert(document.domain)</script>
<img src=x onerror=alert(1)>
<svg onload=alert(1)>
javascript:alert(1)
```

### SQL Injection

```
' OR '1'='1
' UNION SELECT null,null--
' AND EXTRACTVALUE(1,CONCAT(0x7e,version()))
```

### Command Injection

```
; cat /etc/passwd
| ls -la
`whoami`
$(whoami)
```

### Open Redirect

```
https://target.com/redirect?url=https://evil.com
//evil.com
javascript:alert(1)
```

---

## 📊 SEVERITY MATRIX

| Rating   | Example             | Priority |
| -------- | ------------------- | -------- |
| CRITICAL | RCE, SQL Injection  | P1       |
| HIGH     | XSS stored, IDOR    | P2       |
| MEDIUM   | XSS reflected, CSRF | P3       |
| LOW      | Missing headers     | P4       |
| INFO     | Best practices      | P5       |
