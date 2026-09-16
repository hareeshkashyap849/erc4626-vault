# dev-deploy.ps1 — deploy the asset and the vault, then write their addresses to disk.
#
#   powershell -ExecutionPolicy Bypass -File scripts\dev-deploy.ps1 [-Force]
#
# WHY THE ADDRESSES GO INTO A JSON FILE INSTEAD OF STAYING ON SCREEN
#
# Addresses are the one thing in this setup that changes for reasons unrelated to
# the code. Redeploy, or start a fresh chain, and every address is different. If
# the only record is scrollback, then the front end, the notes, and whatever was
# typed into a browser extension all drift apart -- and the failure that produces
# is a dApp pointing at a contract that is not there, which reads as a broken
# app rather than a stale address.
#
# `deployments/local.json` is that single record. `scripts/dev-chain.ps1` creates
# it; the dApp reads it. Nothing else hardcodes an address.
#
# The file is gitignored, because it describes one disposable local chain and
# would be actively misleading in a fresh clone.
$ErrorActionPreference = 'Stop'

# Parsed from $args rather than declared with `param()`. A param block must be the
# first statement in the file, which would put it above the explanation of why the
# script exists. Reading the flag here keeps the reasoning where a reader looks
# first, and costs nothing: there is only one flag.
$Force = $args -contains '-Force' -or $args -contains '--force'

$repo = Split-Path $PSScriptRoot -Parent
$tc = 'D:\1\11111\deepseek\web3-development\web3-development-execute\toolchain'
$env:PATH = "$tc\foundry;$tc\solc;$tc\pylib\bin;" + $env:PATH
$env:FOUNDRY_CACHE_PATH = "$tc\forge-cache"
Set-Location $repo

# See dev-chain.ps1: cast reads http.proxy from the git config, which points at a
# SOCKS5 proxy that is often down, turning every localhost call into a timeout.
$env:NO_PROXY = '127.0.0.1,localhost'
$env:no_proxy = '127.0.0.1,localhost'

$RPC = 'http://127.0.0.1:8545'
$CHAIN_ID = 31337
$outFile = Join-Path $repo 'deployments/local.json'

# anvil account 9: public, worthless, local-only. Chosen because it is the key
# most likely to already be imported into a browser from a previous run.
$BROWSER_KEY = '0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6'
$DEPLOYER_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'

function Step($n, $msg) { Write-Host "`n[$n] $msg" -ForegroundColor Cyan }

# cast prints uint256 returns as "10000000000 [1e10]". Casting that string
# straight to an integer throws, and the failure only shows up once the value is
# large enough to be abbreviated -- so the first version of this check passed by
# luck. Taking the leading digits is the fix.
function Parse-Uint([string]$castOutput) {
  $m = [regex]::Match($castOutput.Trim(), '^\d+')
  if (-not $m.Success) { throw "not a uint from cast: '$castOutput'" }
  return [uint64]$m.Value
}

$env:OWNER_ADDRESS = (cast wallet address --private-key $BROWSER_KEY).Trim()

# Funding is a function rather than a step, and it runs BEFORE the
# already-deployed short-circuit. That ordering is deliberate: the short-circuit
# exists so a re-run does not change your MetaMask configuration, but if funding
# were after it, then a chain whose funding had failed could never be repaired by
# re-running -- the script would keep reporting success on a vault with no USDC
# to deposit. Funding is idempotent and verified, so doing it first is safe.
function Fund-BrowserAccount([string]$assetAddress) {
  $wanted = 10000000000 # 10,000 USDC at 6 decimals
  $have = Parse-Uint (cast call $assetAddress 'balanceOf(address)(uint256)' $env:OWNER_ADDRESS --rpc-url $RPC)
  if ($have -ge $wanted) {
    Write-Host "  already funded ($have)"
    return
  }

  # anvil_setBalance is an anvil-only affordance. Appropriate here precisely
  # because this chain is local and disposable; the same call against a public
  # network would be a lie about where the money came from.
  cast rpc anvil_setBalance $env:OWNER_ADDRESS 0x21e19e0c9bab2400000 --rpc-url $RPC | Out-Null

  # The result is checked. An earlier version piped this into Out-Null, which hid
  # a failed mint: the vault deployed, the state persisted, and the browser
  # showed an empty balance while everything looked like it had worked.
  $sent = & cmd /c "cast send $assetAddress `"mint(address,uint256)`" $env:OWNER_ADDRESS $wanted --private-key $DEPLOYER_KEY --rpc-url $RPC 2>&1" | Out-String
  if ($sent -notmatch 'status\s+1 \(success\)') {
    throw "the mint did not report success`n$sent"
  }

  $now = Parse-Uint (cast call $assetAddress 'balanceOf(address)(uint256)' $env:OWNER_ADDRESS --rpc-url $RPC)
  if ($now -lt $wanted) { throw "mint reported success but the balance is $now, wanted at least $wanted" }
  Write-Host "  funded: $now"
}

if ((Test-Path $outFile) -and -not $Force) {
  $existing = Get-Content $outFile -Raw | ConvertFrom-Json
  $code = (cast code $existing.vault --rpc-url $RPC 2>$null)
  if ($code -and $code.Trim() -ne '0x') {
    Write-Host 'already deployed on this chain:' -ForegroundColor Yellow
    Write-Host "  vault : $($existing.vault)"
    Write-Host "  asset : $($existing.asset)"
    Write-Host ''
    Step '-' 'ensuring the browser account is funded'
    Fund-BrowserAccount $existing.asset
    Write-Host ''
    Write-Host '  pass -Force to redeploy (this changes both addresses)' -ForegroundColor Yellow
    exit 0
  }
  Write-Host 'the recorded addresses are not on this chain any more; redeploying'
}

Step 1 'checking the chain'

$chainId = (cast chain-id --rpc-url $RPC).Trim()
if ($chainId -ne "$CHAIN_ID") { throw "no local chain on $RPC (got chain id '$chainId'); run scripts\dev-chain.ps1 first" }

# The check that would have caught the offline problem. A fork keeps only the
# state it has been asked for and reaches upstream for anything else, so a demo
# on a fork stops working the moment the machine loses its connection.
if ((cast code 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48 --rpc-url $RPC).Trim() -ne '0x') {
  throw 'this chain has mainnet state at the USDC address -- it is a fork, and a fork needs the internet'
}
Write-Host "  chain id $chainId, block $(cast block-number --rpc-url $RPC), not a fork"

Step 2 'deploying'

$env:PRIVATE_KEY = $DEPLOYER_KEY
$scriptAsset = Join-Path $repo 'script/DeployTestAsset.s.sol'
$scriptVault = Join-Path $repo 'script/Deploy.s.sol'

# Forge logs to stderr; PowerShell 5.1 turns that into ErrorRecord objects whose
# formatted text embeds the caller's file and line, which breaks the regexes.
function Invoke-ForgeScript([string]$p) { (& cmd /c "forge script `"$p`" --rpc-url $RPC --broadcast 2>&1") | Out-String }

$assetOut = Invoke-ForgeScript $scriptAsset
$asset = ([regex]::Match($assetOut, 'test asset deployed at:\s*(0x[0-9a-fA-F]{40})')).Groups[1].Value
if (-not $asset) { throw "could not read the asset address`n$assetOut" }
Write-Host "  asset: $asset"

$env:ASSET_ADDRESS = $asset
$vaultOut = Invoke-ForgeScript $scriptVault
$vault = ([regex]::Match($vaultOut, 'address\s+:\s*(0x[0-9a-fA-F]{40})')).Groups[1].Value
if (-not $vault) { throw "could not read the vault address`n$vaultOut" }
$deployBlock = ([regex]::Match($vaultOut, 'deployBlock\s+:\s*(\d+)')).Groups[1].Value
Write-Host "  vault: $vault  (block $deployBlock)"

Step 3 'funding the browser account'

Fund-BrowserAccount $asset

Step 4 "writing $outFile"

# deployBlock is included for the same reason the testnet record includes it:
# an indexer needs a start block, and getting it wrong fails silently in both
# directions -- before deployment finds no events, after it misses the early ones.
$record = [ordered]@{
  chainId     = $CHAIN_ID
  rpcUrl      = $RPC
  vault       = $vault
  asset       = $asset
  owner       = $env:OWNER_ADDRESS
  deployBlock = [int]$deployBlock
  note        = 'One disposable local chain. Addresses change if you rerun the deploy script.'
}
$json = $record | ConvertTo-Json
[System.IO.File]::WriteAllText($outFile, $json, (New-Object System.Text.UTF8Encoding($false)))
Write-Host "  written"

$eth = (cast balance $env:OWNER_ADDRESS --rpc-url $RPC --ether).Trim()
$usdc = (cast call $asset 'balanceOf(address)(uint256)' $env:OWNER_ADDRESS --rpc-url $RPC).Trim()

Write-Host ''
Write-Host '================ MetaMask ================' -ForegroundColor Green
Write-Host "  network : Anvil Local / $RPC / chain $CHAIN_ID / ETH"
Write-Host ''
Write-Host '  import account (SEPARATE from your main one -- MetaMask assigns nonces'
Write-Host '  from the state it has of that address on the network you last used, so a'
Write-Host '  mainnet account sends nonce 40-something to a chain expecting 0):'
Write-Host "    key     : $BROWSER_KEY"
Write-Host "    address : $env:OWNER_ADDRESS"
Write-Host ''
Write-Host '  import token (Import tokens > Custom token):'
Write-Host "    address : $asset   (USDC, 6 decimals, autofilled)"
Write-Host ''
Write-Host '================ balances ================' -ForegroundColor Green
Write-Host "  ETH  : $eth"
Write-Host "  USDC : $usdc"
