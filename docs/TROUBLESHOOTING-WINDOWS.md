# Claude Statusline — Troubleshooting no Windows

## Pré-requisitos

| Requisito | Versão mínima | Verificar |
|---|---|---|
| Claude Code | 2.1.144+ | `claude --version` |
| Node.js | Qualquer LTS | `node --version` |

---

## Caso 1: Node.js não encontrado

**Sintoma**
```
✗ node is required. Install Node.js or make sure it's on PATH.
```

**Causa**
O instalador não encontrou `node.exe` no PATH do sistema. O Claude Code no Windows é um executável único e não inclui Node.js embutido.

**Solução**
```powershell
winget install --id OpenJS.NodeJS.LTS -e --silent --accept-package-agreements --accept-source-agreements
```
Após instalar, feche e reabra o terminal para o PATH ser atualizado, depois execute o instalador novamente.

---

## Caso 2: Statusline instalado mas não aparece

**Sintoma**
Instalação concluída com sucesso (`✓ done`), Claude Code reiniciado, mas nenhuma linha aparece na interface.

**Diagnóstico**
Verifique se o comando executa corretamente de forma manual:
```powershell
node C:/Users/<usuario>/.claude/statusline.js
```
Saída esperada: duas linhas com informações de git, modelo, custo e contexto.

**Causa mais comum — aspas escapadas no `settings.json`**

O instalador gera o comando com aspas duplas escapadas, que falham silenciosamente no Windows:
```json
// ERRADO — aspas escapadas causam falha silenciosa
"command": "\"C:/Program Files/nodejs/node.exe\" \"C:/Users/filipe/.claude/statusline.js\""
```

**Solução**
Edite `C:\Users\<usuario>\.claude\settings.json` e substitua pelo formato sem aspas:
```json
"statusLine": {
  "type": "command",
  "command": "node C:/Users/<usuario>/.claude/statusline.js"
}
```
> Use barras `/` e não `\` no caminho. Reinicie o Claude Code após a edição.

---

## Caso 3: Ícones aparecem como □ (quadrados)

**Sintoma**
O statusline aparece mas exibe caixas `□` no lugar dos ícones.

**Causa**
Nenhuma Nerd Font instalada no terminal.

**Solução A — instalar Nerd Font**
```powershell
winget install --id=DEVCOM.JetBrainsMonoNerdFont
```
Após instalar, configure a fonte do terminal para `JetBrainsMono Nerd Font` e reinicie o terminal.

**Solução B — modo ASCII (sem instalar fonte)**
Defina a variável de ambiente para usar fallback ASCII:
```powershell
[Environment]::SetEnvironmentVariable('CLAUDE_STATUSLINE_PLAIN', '1', 'User')
```
Reinicie o Claude Code para aplicar.

---

## Caso 4: Erro de parse no Windows PowerShell 5.x

**Sintoma**
```
'}' de fechamento ausente no bloco de instrução ou na definição de tipo.
```

**Causa**
O script `install.ps1` ou scripts relacionados contêm caracteres Unicode (ex: `—` em dash) que o Windows PowerShell 5.x não consegue decodificar corretamente em arquivos UTF-8 sem BOM.

**Solução**
Execute o instalador com PowerShell 7:
```powershell
winget install --id Microsoft.PowerShell -e
pwsh -Command "irm https://raw.githubusercontent.com/andregosling/claude-statusline/main/install.ps1 | iex"
```

---

## Caso 5: `claude-statusline` não reconhecido no terminal

**Sintoma**
```
O termo 'claude-statusline' não é reconhecido como nome de cmdlet...
```

**Causa**
O diretório `~\.claude\bin` não está no PATH do usuário.

**Solução**
```powershell
[Environment]::SetEnvironmentVariable('Path', "$([Environment]::GetEnvironmentVariable('Path','User'));$env:USERPROFILE\.claude\bin", 'User')
```
Reinicie o terminal para aplicar.

---

## Verificação completa

Execute este bloco para diagnosticar todos os pontos de uma vez:

```powershell
Write-Host "=== Claude Code ===" -ForegroundColor Cyan
claude --version

Write-Host "`n=== Node.js ===" -ForegroundColor Cyan
node --version 2>&1

Write-Host "`n=== settings.json ===" -ForegroundColor Cyan
Get-Content "$env:USERPROFILE\.claude\settings.json" | Select-String "statusLine","command" -Context 0,2

Write-Host "`n=== Teste do comando ===" -ForegroundColor Cyan
node "$env:USERPROFILE/.claude/statusline.js"

Write-Host "`n=== PATH (claude bin) ===" -ForegroundColor Cyan
$env:PATH -split ";" | Where-Object { $_ -like "*\.claude\bin*" }
```

---

## Referências

- Repositório: `https://github.com/andregosling/claude-statusline`
- Configuração `settings.json`: chave `statusLine` (camelCase), campo `type: "command"` e `command`
- Nerd Fonts: `https://www.nerdfonts.com/font-downloads`
