# dev-chain.ps1 — bring up the whole local demo from nothing.
#
#   powershell -ExecutionPolicy Bypass -File scripts\dev-chain.ps1
#
# Then add the network and account to MetaMask using the values it prints.
#
# WHY THIS IS A SCRIPT AND NOT FIVE COMMANDS IN A README
#
# The commands are not the hard part; the hard part is that several of them have
# to agree. The account that receives the USDC must be the one imported into the
# browser. The address the vault is deployed against must be the asset that was
# just deployed. And the chain must NOT be a mainnet fork, or every query for an
# address that has not been cached yet reaches out to the internet and the demo
# stops working the moment the machine is offline. That last mistake was made
# once already; this script is how it stops being possible.
#
# WHAT IT DOES NOT DO
#
# It does not touch the network, it does not need a funded account, and it does
# not need any faucet. The chain it starts is entirely self-contained: nothing on
# it refers to a contract that does not live in its own state.
$ErrorActionPreference = 'Stop'

$repo = Split-Path $PSScriptRoot -Parent
$tc = 'D:\1\11111\deepseek\web3-development\web3-development-execute\toolchain'
$env:PATH = "$tc\foundry;$tc\solc;$tc\pylib\bin;" + $env:PATH
$env:FOUNDRY_CACHE_PATH = "$tc\forge-cache"

# forge resolves `script/...` relative to the working directory, and this script
# is invoked from wherever the caller happens to be. Without this, `forge` looks
# for the script in the caller's directory and fails with a message about
# contract source format that reads like a syntax error in the .sol file.
Set-Location $repo
$scriptAsset = Join-Path $repo 'script/DeployTestAsset.s.sol'
$scriptVault = Join-Path $repo 'script/Deploy.s.sol'

# `cast` reads http.proxy out of the git config, and this workspace's config
# points at a SOCKS5 proxy that is frequently not running. Every localhost call
# then vanishes into a dead proxy and reports "connection refused" or a timeout
# -- which reads exactly like anvil being down. Bypass the proxy for localhost.
$env:NO_PROXY = '127.0.0.1,localhost'
$env:no_proxy = '127.0.0.1,localhost'

$RPC = 'http://127.0.0.1:8545'
$CHAIN_ID = 31337

# anvil's account index 9: a public, universally known test key. Using anvil's
# own accounts rather than a generated key means this script is reproducible --
# run it twice and the browser account is the same address. It also means the key
# is genuinely worthless, which is the only kind of key that should ever be typed
# into a browser extension.
$BROWSER_KEY = '0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6'
$DEPLOYER_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'

function Step($n, $msg) { Write-Host "`n[$n] $msg" -ForegroundColor Cyan }

# ---------------------------------------------------------------- 1. the chain

Step 1 'starting a LOCAL chain (no fork -- it must work offline)'

$already = Get-NetTCPConnection -LocalPort 8545 -State Listen -ErrorAction SilentlyContinue
if ($already) {
  Write-Host "  port 8545 is already in use (pid $($already[0].OwningProcess))"
  Write-Host '  assuming anvil is already running; if it is something else, stop it first'
} else {
  # --state makes the chain survive a restart. Without it anvil keeps everything
  # in memory, so shutting the machine down discards the contracts and balances
  # and the next start begins at block 0 with nothing deployed. With it, the
  # chain resumes where it left off, which also means the addresses recorded in
  # deployments/local.json stay valid.
  #
  # The file is gitignored: it is one disposable chain's state, not an artifact
  # anyone else should inherit.
  $stateFile = Join-Path $repo 'deployments/anvil-state.json'
  $resuming = Test-Path $stateFile
  if ($resuming) {
    Write-Host "  resuming the saved chain state ($([Math]::Round((Get-Item $stateFile).Length / 1KB)) KB)"
  } else {
    Write-Host '  no saved state; starting a fresh chain'
  }

  # --load-state versus --state matters. They behave as aliases when the file
  # exists, but only --dump-state / --state writes on exit; a run started with
  # --load-state alone loads and then discards. So the flag follows which of the
  # two things we are doing.
  $stateArg = if ($resuming) { '--load-state' } else { '--state' }

  # Start-Process WITHOUT -WindowStyle. With it, the shell keeps waiting on the
  # child it created, so anvil stayed inside this script's process tree and died
  # the moment the script returned -- which silently destroys the entire point of
  # persisting state. A plain Start-Process detaches it, so anvil outlives both
  # this script and the terminal that ran it.
  Start-Process -FilePath 'anvil' -ArgumentList @(
    '--port', '8545',
    '--chain-id', "$CHAIN_ID",
    '--block-time', '2',
    '--host', '127.0.0.1',
    $stateArg, "`"$stateFile`"",
    '--state-interval', '5'
  ) | Out-Null
  Write-Host '  started anvil (detached; it outlives this script and the terminal)'
  Start-Sleep -Seconds 7
}

$chainId = (cast chain-id --rpc-url $RPC).Trim()
if ($chainId -ne "$CHAIN_ID") { throw "unexpected chain id: $chainId" }
Write-Host "  chainId $chainId, block $(cast block-number --rpc-url $RPC)"

# Prove it is not forking. On a fork, mainnet USDC would have code; here it must
# be empty. This is the check that would have caught the offline problem.
$usdcCode = (cast code 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48 --rpc-url $RPC).Trim()
if ($usdcCode -ne '0x') {
  throw 'this chain has mainnet state at the USDC address -- it is a FORK, and a fork needs the internet for uncached reads'
}
Write-Host '  confirmed not a fork (mainnet USDC address is empty)'

# ---------------------------------------------------- 2. deploy and report

# Delegated so the deployment logic exists in exactly one place. Two copies of
# "how to deploy" would drift, and the one that drifted would be the one nobody
# ran recently.
Step 2 'deploying (handing off to dev-deploy.ps1)'

& (Join-Path $PSScriptRoot 'dev-deploy.ps1') @args