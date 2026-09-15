import { randomUUID } from "node:crypto";
import { dockerArgs, dockerEnabled, dockerHostEnv, dockerRun } from "./docker.js";

const runner = String.raw`
import os,sys,subprocess,signal,pty,select,tty,termios
marker=sys.argv[1]
use_pty=sys.argv[2]=='pty'
del sys.argv[2]
if use_pty:
  pid,master=pty.fork()
  if pid==0: os.execvp(sys.argv[2],sys.argv[2:])
  with open(marker,'x') as f: f.write(str(pid))
  previous=termios.tcgetattr(0) if os.isatty(0) else None
  try:
    if previous: tty.setraw(0)
    while True:
      ready,_,_=select.select([0,master],[],[])
      if master in ready:
        try: data=os.read(master,65536)
        except OSError: break
        if not data: break
        os.write(1,data)
      if 0 in ready:
        data=os.read(0,65536)
        if not data: break
        os.write(master,data)
    _,status=os.waitpid(pid,0)
    code=os.waitstatus_to_exitcode(status)
  finally:
    if previous: termios.tcsetattr(0,termios.TCSADRAIN,previous)
    os.close(master)
    try: os.unlink(marker)
    except FileNotFoundError: pass
else:
  child=subprocess.Popen(sys.argv[2:],start_new_session=True)
  with open(marker,'x') as f: f.write(str(child.pid))
  try: code=child.wait()
  finally:
    try: os.unlink(marker)
    except FileNotFoundError: pass
sys.exit(code if code>=0 else 128-code)
`;
const killer = String.raw`
import os,sys,signal
try:
  with open(sys.argv[1]) as f: pid=int(f.read())
  if pid>1: os.killpg(pid,getattr(signal,sys.argv[2]))
except (FileNotFoundError,ProcessLookupError): pass
`;

export interface ExecutionLaunch {
  file: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  signal?: (signal: "SIGINT" | "SIGTERM" | "SIGKILL") => void;
}
export function executionLaunch(file: string, args: string[], cwd: string, env: Record<string, string>, tty = false): ExecutionLaunch {
  if (!dockerEnabled()) return { file, args, cwd, env: { ...process.env, ...env } };
  const marker = `/tmp/neo-exec-${randomUUID()}.pid`;
  return {
    file: "docker", args: dockerArgs(["python3", "-c", runner, marker, tty ? "pty" : "pipe", file, ...args], cwd, env),
    cwd: process.cwd(), env: dockerHostEnv(),
    signal: signal => {
      // Signal inside the container, never a host PID supplied by the model.
      void dockerRun(dockerArgs(["python3", "-c", killer, marker, signal])).catch(() => {});
    },
  };
}
