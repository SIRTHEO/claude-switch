# Smart Add Account — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rendere `add_account` intelligente: chiede email attesa, verifica post-login, gestisce mismatch con retry, e distingue "salvato" da "aggiornato" per account duplicati.

**Architecture:** Modifica solo la funzione `add_account` in `claude-switch`, aggiungendo un helper `save_and_report` per la logica salva/aggiorna con messaggio. Il flusso diventa: prompt email → login → verifica → salva/aggiorna → eventuale retry.

**Tech Stack:** Zsh, inline Python (gia' usato nel progetto)

---

### Task 1: Aggiungere helper `save_and_report`

**Files:**
- Modify: `claude-switch:48-63` (dopo `save_account`, prima di `load_account`)

Questo helper wrappa `save_account` aggiungendo il messaggio corretto in base a se l'account esisteva gia'.

- [ ] **Step 1: Aggiungere la funzione `save_and_report` dopo `save_account`**

Inserire dopo la chiusura di `save_account` (riga 63):

```zsh
save_and_report() {
  local email="$1"
  local active_email="$2"
  local already_exists=false

  [[ -f "$ACCOUNTS_DIR/$email.json" ]] && already_exists=true

  save_account "$email"

  if [[ "$email" == "$active_email" ]]; then
    echo "Autenticato: $email (gia' l'account attivo)"
    echo "Token aggiornato."
  elif [[ "$already_exists" == "true" ]]; then
    echo "Autenticato: $email"
    echo "Aggiornato: $email (account gia' presente)"
  else
    echo "Autenticato: $email"
    echo "Salvato: $email"
  fi
}
```

- [ ] **Step 2: Verificare che lo script funzioni ancora**

Run: `./claude-switch switch list`
Expected: lista account invariata, nessun errore

- [ ] **Step 3: Commit**

```bash
git add claude-switch
git commit -m "feat: add save_and_report helper for smart account messages"
```

---

### Task 2: Riscrivere `add_account` con prompt email e verifica

**Files:**
- Modify: `claude-switch:177-205` (funzione `add_account`)

- [ ] **Step 1: Sostituire la funzione `add_account`**

Sostituire l'intera funzione `add_account` (righe 177-205, dopo l'aggiunta di Task 1 le righe saranno spostate — riferirsi al contenuto) con:

```zsh
add_account() {
  local current_email
  current_email="$(get_current_email)"

  # Chiedi email attesa (opzionale)
  local expected_email=""
  printf "Email da aggiungere (invio per saltare): "
  read -r expected_email

  if [[ -n "$current_email" ]]; then
    save_account "$current_email"
  fi

  echo ""
  echo "Apri il browser e autorizza l'account."
  echo ""
  "$CLAUDE_BIN" auth login

  local new_email
  new_email="$(get_current_email)"

  if [[ -z "$new_email" ]]; then
    echo "Login fallito o annullato."
    if [[ -n "$current_email" ]]; then
      load_account "$current_email"
    fi
    return 1
  fi

  echo ""
  save_and_report "$new_email" "$current_email"

  # Se c'era un'email attesa e non corrisponde, offri retry
  if [[ -n "$expected_email" && "$new_email" != "$expected_email" ]]; then
    echo ""
    echo "(diverso da $expected_email)"
    echo ""
    printf "Riprovare il login per $expected_email? [y/N]: "
    read -r retry_choice

    if [[ "$retry_choice" == "y" || "$retry_choice" == "Y" ]]; then
      echo ""
      echo "Apri il browser e autorizza l'account."
      echo ""
      "$CLAUDE_BIN" auth login

      local retry_email
      retry_email="$(get_current_email)"

      if [[ -z "$retry_email" ]]; then
        echo "Login fallito o annullato."
        return 1
      fi

      echo ""
      save_and_report "$retry_email" "$current_email"

      if [[ "$retry_email" != "$expected_email" ]]; then
        echo ""
        echo "(diverso da $expected_email — nessun ulteriore retry)"
      fi
    fi
  fi
}
```

- [ ] **Step 2: Verificare che lo script parsa correttamente**

Run: `zsh -n claude-switch`
Expected: nessun output (nessun errore di sintassi)

- [ ] **Step 3: Commit**

```bash
git add claude-switch
git commit -m "feat: smart add_account with email verification and retry"
```

---

### Task 3: Aggiornare README

**Files:**
- Modify: `README.md` sezione "Initial setup" (righe 54-78)

- [ ] **Step 1: Aggiornare la sezione Initial setup nel README**

Sostituire la sezione "### 1. Save your current account" e "### 2. Add a second account" con:

```markdown
### 1. Save your current account

If you're already logged in to Claude Code, save it:

```bash
claude switch add
```

When prompted for an email, enter the email of your current account (or press Enter to skip). This saves the currently active account without requiring a new login.

### 2. Add a second account

Run `claude switch add` again and enter the email of the new account:

```
Email da aggiungere (invio per saltare): personal@gmail.com
```

This opens the browser for the OAuth flow. If you accidentally authorize with a different email, the account is still saved — and you're offered the chance to retry for the original email.
```

- [ ] **Step 2: Verificare che il README sia valido markdown**

Run: `head -80 README.md`
Expected: markdown ben formattato

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: update README for smart add-account flow"
```
