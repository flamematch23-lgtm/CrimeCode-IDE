# Bug Bounty Workflow Guide

## Fase 1: Reconnaissance Automatizzata

### Obiettivo: Mappare la superficie d'attacco

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
                    FASE 1: RECON
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

1. WHOIS Lookup
   → Chi possiede il dominio?
   → Nameserver, contatti admin
   → Date di registrazione (recon antiga?)

   Prompt: "Fai un WHOIS lookup di example.com"

2. DNS Enumeration
   → Tutti i record DNS disponibili
   → Scopri sottodomini nascosti

   Prompt: "Fai DNS lookup completo di example.com (A, MX, TXT, CNAME, AAAA, NS)"

3. Subdomain Discovery
   → Usa DNS lookup per trovare sottodomini comuni

   Prompt: "Enumera i sottodomini di example.com cercando: www, api, dev, staging, test, admin, panel, cdn, static"
```

---

## Fase 2: Analisi HTTPS/TLS

### Obiettivo: Identificare problemi di configurazione SSL

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
                    FASE 2: SSL/TLS ANALYSIS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

1. SSL Certificate Check
   → Scadenza certificato
   → Issuer, validità
   → Cipher supportati

   Prompt: "Esegui SSL check su api.example.com porta 443"

2. Security Headers Analysis
   → Missing security headers
   → CSP debole
   → HSTS mancante

   Prompt: "Analizza gli security headers di https://www.example.com"
```

---

## Fase 3: Port & Service Discovery

### Obiettivo: Identificare servizi esposti

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
                    FASE 3: SCANNING
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

1. Port Scan - Primary
   → Porte comuni: 80, 443, 22, 21, 25, 3389

   Prompt: "Scan le porte 22, 80, 443, 3306, 5432, 6379, 8080, 8443 su target.com"

2. Port Scan - Extended
   → Porte alternate, database, cache

   Prompt: "Scan le porte 1-1000 su target.com con timeout 3000ms"

3. Service Fingerprinting
   → Identifica versioni dei servizi
   → Cerca CVE noti
```

---

## Fase 4: Web Application Analysis

### Obiettivo: Trovare vulnerabilità OWASP Top 10

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
                    FASE 4: WEB TESTING
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

1. URL Analysis
   → Analizza parametri URL
   → Cerca Open Redirect, SSRF

   Prompt: "Analizza https://api.example.com/redirect?url=https://evil.com"

2. Parameter Discovery
   → Cerca parametri nascosti
   → Prova encoding/evasion

   Prompt: "Testa questi URL per open redirect:
   - https://app.example.com/redirect?url=javascript:alert(1)
   - https://app.example.com/redirect?url=//evil.com
   - https://app.example.com/redirect?url=%2F%2Fevil.com"

3. XSS Testing
   → Testa input fields
   → Prova encoding bypass

   Prompt: "Prova questi payload XSS:
   - <script>alert(document.domain)</script>
   - <img src=x onerror=alert(1)>
   - <svg onload=alert(1)>"
```

---

## Fase 5: Credential & Hash Analysis

### Obiettivo: Verificare leak e credenziali deboli

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
                    FASE 5: CREDENTIALS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

1. Hash Verification
   → Verifica se hash sono in database leak

   Prompt: "Calcola hash SHA256 di 'password123'"

2. Password Strength Analysis
   → Genera password candidate
   → Testa pattern comuni

   Prompt: "Genera una wordlist per admin/test/root con anno 2024"

3. Common Password Check
   → Testa credenziali di default

   Prompt: "Genera top 50 password comuni per bruteforce login"
```

---

## Fase 6: Vulnerability Specific Testing

### Obiettivo: Testare vulnerabilità specifiche

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
                    FASE 6: VULN TESTING
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

1. SQL Injection
   → Testa parametri con payload SQL

   Prompt: "Testa SQL injection su:
   - https://api.example.com/users?id=1' OR '1'='1
   - https://api.example.com/search?q=test' UNION SELECT null,null--

2. SSRF Testing
   → Cerca fetch di URL controllati dall'utente

   Prompt: "Testa SSRF:
   - https://api.example.com/fetch?url=http://localhost:22
   - https://api.example.com/fetch?url=http://169.254.169.254"

3. SSTI Testing
   → Template injection

   Prompt: "Testa SSTI:
   - https://app.example.com?name={{7*7}}
   - https://app.example.com?name=${7*7}"
```

---

## Fase 7: Report Generation

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
                    REPORT TEMPLATE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

## Target Information
- Domain: example.com
- IP(s): x.x.x.x
- Scope: *.example.com

## Findings

### [CRITICAL] Title
- Description: ...
- PoC: ...
- Impact: ...
- Remediation: ...

### [HIGH] Title
- ...

### [MEDIUM] Title
- ...

## Tools Used
- DNS Lookup
- SSL Checker
- Port Scanner
- Security Headers
- URL Analyzer
- Encoding/Hash tools
```

---

## Quick Commands Reference

```bash
# Recon rapido
whois example.com
dnslookup example.com ALL
ssl_checker example.com 443
security_headers https://example.com
port_scanner example.com "22,80,443,3306,8080"

# Encoding rapido
encode "test<script>" URL
encode "test" BASE64
hash "password" SHA256

# Password/Hash
password_generator length=32 special=true
hash "suspect_hash" MD5
wordlist pattern="admin" year=2024
```
