#!/bin/sh
# token-usage-anatomy: file helper for macOS and Linux.
#
# The hooks module cannot append to a file or read part of one (its file
# API reads and writes whole files of up to 4 MiB), so hooks/io.ts runs this
# script for those two jobs. Every path and number arrives as its own
# argument; nothing is ever pasted into a command string.
#
#   io.sh assistant <file> <byte offset>
#       Prints one tab-separated line per assistant response in a Claude Code
#       transcript, from <byte offset> on: sidechain (1/0), request id,
#       input, cache creation, cache read, output, thinking tokens, 5-minute
#       writes, 1-hour writes, speed, inference geo. A field the response
#       lacks prints as "-". Nothing else from the transcript is printed.
#
#   io.sh titles <file>
#       Prints the transcript's title lines (generated and /rename titles).
#
#   io.sh append <file>
#       Appends standard input to <file>, creating its folder first.

set -eu

command=${1:-}

case "$command" in
  assistant)
    file=$2
    offset=$3
    case "$offset" in
      '' | *[!0-9]*)
        echo "io.sh: the offset must be a whole number" >&2
        exit 2
        ;;
    esac

    tail -c +"$((offset + 1))" -- "$file" | awk '
      # The value of "name":<digits> in s, or "-".
      function number(s, name) {
        if (match(s, "\"" name "\":[0-9]+")) {
          return substr(s, RSTART + length(name) + 3, RLENGTH - length(name) - 3)
        }
        return "-"
      }
      # The value of "name":"<text>" in s, or "-".
      function text(s, name) {
        if (match(s, "\"" name "\":\"[^\"]*\"")) {
          return substr(s, RSTART + length(name) + 4, RLENGTH - length(name) - 5)
        }
        return "-"
      }
      index($0, "\"type\":\"assistant\"") > 0 && index($0, "\"requestId\":\"") > 0 {
        # The response usage is the last "usage" object on the line; its own
        # counts come before its "iterations", so the first match of each
        # name after it is the one wanted. The request id follows it too.
        rest = $0
        at = 0
        while ((i = index(rest, "\"usage\":{")) > 0) {
          at += i
          rest = substr(rest, i + 1)
        }
        if (at == 0) next
        usage = substr($0, at)
        side = index($0, "\"isSidechain\":true") > 0 ? "1" : "0"
        printf "%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n", side, text(usage, "requestId"),
          number(usage, "input_tokens"), number(usage, "cache_creation_input_tokens"),
          number(usage, "cache_read_input_tokens"), number(usage, "output_tokens"),
          number(usage, "thinking_tokens"), number(usage, "ephemeral_5m_input_tokens"),
          number(usage, "ephemeral_1h_input_tokens"), text(usage, "speed"),
          text(usage, "inference_geo")
      }
    '
    ;;

  titles)
    file=$2
    grep -E '^\{"type":"(ai-title|custom-title)"' -- "$file" || true
    ;;

  append)
    file=$2
    mkdir -p -- "$(dirname -- "$file")"
    cat >> "$file"
    ;;

  *)
    echo "usage: io.sh assistant <file> <offset> | titles <file> | append <file>" >&2
    exit 2
    ;;
esac
