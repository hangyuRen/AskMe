# Load with: eval "$(command ask init zsh)"
ask() {
  local history_file result
  history_file=$(mktemp) || return 1
  chmod 600 "$history_file"
  fc -ln -30 > "$history_file"
  ASK_TERMINAL_ID="${ASK_TERMINAL_ID:-$TTY}" command ask --history-file "$history_file" "$@"
  result=$?
  rm -f "$history_file"
  return $result
}
