# token-usage-anatomy: file helper for Windows (Windows PowerShell 5.1 or
# PowerShell 7).
#
# The hooks module cannot append to a file or read part of one (its file
# API reads and writes whole files of up to 4 MiB), so hooks/io.ts runs this
# script for those two jobs, with -File and each path and number as its own
# argument; nothing is ever pasted into a command string. It does exactly
# what scripts/io.sh does on macOS and Linux:
#
#   io.ps1 assistant <file> <byte offset>
#       One tab-separated line per assistant response in a Claude Code
#       transcript, from <byte offset> on: sidechain (1/0), request id,
#       input, cache creation, cache read, output, thinking tokens, 5-minute
#       writes, 1-hour writes, speed, inference geo; "-" for a missing field.
#
#   io.ps1 titles <file>
#       The transcript's title lines (generated and /rename titles).
#
#   io.ps1 append <file>
#       Appends standard input to <file>, creating its folder first.

param(
  [Parameter(Mandatory = $true, Position = 0)][string]$Command,
  [Parameter(Mandatory = $true, Position = 1)][string]$File,
  [Parameter(Position = 2)][long]$Offset = 0
)

$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = $utf8

function Get-Number([string]$Text, [string]$Name) {
  $m = [regex]::Match($Text, '"' + $Name + '":([0-9]+)')
  if ($m.Success) { return $m.Groups[1].Value }
  return '-'
}

function Get-Text([string]$Text, [string]$Name) {
  $m = [regex]::Match($Text, '"' + $Name + '":"([^"]*)"')
  if ($m.Success) { return $m.Groups[1].Value }
  return '-'
}

function Open-Shared([string]$Path) {
  # Claude Code keeps writing the transcript: open it read-only, shared.
  return [System.IO.File]::Open($Path, 'Open', 'Read', 'ReadWrite')
}

switch ($Command) {
  'assistant' {
    $stream = Open-Shared $File
    try {
      [void]$stream.Seek($Offset, 'Begin')
      $reader = New-Object System.IO.StreamReader($stream, $utf8)
      $out = New-Object System.Text.StringBuilder
      while ($null -ne ($line = $reader.ReadLine())) {
        if (-not $line.Contains('"type":"assistant"') -or -not $line.Contains('"requestId":"')) { continue }
        # The response usage is the last "usage" object on the line; its own
        # counts come before its "iterations", so the first match of each
        # name after it is the one wanted. The request id follows it too.
        $at = $line.LastIndexOf('"usage":{')
        if ($at -lt 0) { continue }
        $usage = $line.Substring($at)
        $side = if ($line.Contains('"isSidechain":true')) { '1' } else { '0' }
        $fields = @(
          $side,
          (Get-Text $usage 'requestId'),
          (Get-Number $usage 'input_tokens'),
          (Get-Number $usage 'cache_creation_input_tokens'),
          (Get-Number $usage 'cache_read_input_tokens'),
          (Get-Number $usage 'output_tokens'),
          (Get-Number $usage 'thinking_tokens'),
          (Get-Number $usage 'ephemeral_5m_input_tokens'),
          (Get-Number $usage 'ephemeral_1h_input_tokens'),
          (Get-Text $usage 'speed'),
          (Get-Text $usage 'inference_geo')
        )
        [void]$out.Append(($fields -join "`t")).Append("`n")
      }
      [Console]::Out.Write($out.ToString())
    } finally {
      $stream.Dispose()
    }
  }

  'titles' {
    $stream = Open-Shared $File
    try {
      $reader = New-Object System.IO.StreamReader($stream, $utf8)
      $out = New-Object System.Text.StringBuilder
      while ($null -ne ($line = $reader.ReadLine())) {
        if ($line -match '^\{"type":"(ai-title|custom-title)"') { [void]$out.Append($line).Append("`n") }
      }
      [Console]::Out.Write($out.ToString())
    } finally {
      $stream.Dispose()
    }
  }

  'append' {
    [Console]::InputEncoding = $utf8
    $text = [Console]::In.ReadToEnd()
    $folder = [System.IO.Path]::GetDirectoryName($File)
    if ($folder) { [void][System.IO.Directory]::CreateDirectory($folder) }
    [System.IO.File]::AppendAllText($File, $text, $utf8)
  }

  default {
    [Console]::Error.WriteLine('usage: io.ps1 assistant <file> <offset> | titles <file> | append <file>')
    exit 2
  }
}
