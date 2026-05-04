# Smart Add Account — Design Spec

## Problema

`claude switch add` apre il browser per l'OAuth ma non verifica quale email viene autenticata. Se l'utente autorizza con l'email sbagliata, l'account viene salvato senza alcun feedback. Non c'e' modo di accorgersi dell'errore fino a quando non si nota l'account attivo sbagliato.

## Soluzione

Rendere `add_account` intelligente: chiedere l'email attesa prima del login, verificare dopo, e gestire ogni caso senza mai buttare via un'autenticazione valida.

## Flusso dettagliato

### 1. Prompt email prima del login

```
Email da aggiungere (invio per saltare): 
```

- Se l'utente inserisce un'email: diventa `expected_email`, usata per la verifica post-login
- Se preme invio: `expected_email` resta vuoto, nessuna verifica (comportamento legacy)

### 2. Salvataggio account corrente

Come oggi: se c'e' un account attivo, viene salvato prima di aprire il browser.

### 3. Login via browser

Chiama `claude auth login` come oggi.

### 4. Verifica post-login

Legge l'email autenticata da `~/.claude.json`. Tre scenari:

#### 4a. Match (o nessuna email attesa)

```
Autenticato: work@company.com
Salvato: work@company.com
```

Se l'account esisteva gia':

```
Autenticato: work@company.com
Aggiornato: work@company.com (account gia' presente)
```

#### 4b. Mismatch

```
Autenticato: personal@gmail.com (diverso da work@company.com)
Salvato: personal@gmail.com
Riprovare il login per work@company.com? [y/N]:
```

- `y`: riapre il browser (un solo retry, poi si ferma)
- `n` o invio: finisce, resta sull'account autenticato

Se anche l'account da mismatch esisteva gia', mostra "Aggiornato" invece di "Salvato".

#### 4c. Login fallito

```
Login fallito o annullato.
```

Ripristina l'account precedente se ce n'era uno.

### 5. Retry (max 1)

Se l'utente chiede retry dopo un mismatch:
- Riapre il browser
- Stessa logica di verifica (match/mismatch/fallito)
- Se mismatch di nuovo: salva comunque, informa, niente ulteriore retry

## Gestione duplicati

`save_account` sovrascrive gia' il file se esiste. La modifica e' solo nel messaggio mostrato all'utente:

- File non esisteva: `Salvato: email`
- File esisteva: `Aggiornato: email (account gia' presente)`

La distinzione si fa con un semplice `[[ -f "$ACCOUNTS_DIR/$email.json" ]]` prima del salvataggio.

## Caso account attivo identico

Se dopo il login l'email autenticata e' uguale a quella attualmente attiva:

```
Autenticato: work@company.com (gia' l'account attivo)
Token aggiornato.
```

## Modifiche al codice

### File: `claude-switch`

#### Funzione `add_account` — riscrittura

Flusso:
1. `read -r expected_email` con prompt
2. `save_account "$current_email"` se esiste
3. `claude auth login`
4. `get_current_email` → `new_email`
5. Se `new_email` vuoto → fallito, ripristina
6. Determina se account gia' presente (`[[ -f ... ]]`)
7. `save_account "$new_email"`
8. Mostra messaggio appropriato (salvato/aggiornato/attivo)
9. Se `expected_email` non vuoto e diverso da `new_email` → offri retry
10. Se retry accettato → ripeti passi 3-8 (una sola volta)

#### Nessun'altra funzione cambia

`save_account`, `load_account`, `get_current_email`, `switch_to`, ecc. restano invariate.

## Non in scope

- Verifica validita' token (richiederebbe chiamate API)
- Auto-save al primo uso
- Sotto-menu "nuovo vs aggiorna" (la distinzione e' automatica)
