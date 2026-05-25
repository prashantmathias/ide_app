export class DenoDebugger {
  private ws: WebSocket | null = null;
  private messageId = 1;
  private callbacks = new Map<number, Function>();
  
  public onPaused: ((callFrames: any[]) => void) | null = null;
  public onResumed: (() => void) | null = null;
  public onDisconnected: (() => void) | null = null;

  async connect(wsUrl: string) {
    this.ws = new WebSocket(wsUrl);
    
    this.ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      this.handleMessage(msg);
    };
    
    this.ws.onclose = () => {
      if (this.onDisconnected) this.onDisconnected();
    };
    
    await new Promise(r => this.ws!.onopen = r);
    
    await this.send("Runtime.enable");
    await this.send("Debugger.enable");
    await this.send("Runtime.runIfWaitingForDebugger");
  }

  send(method: string, params: any = {}): Promise<any> {
    return new Promise((resolve) => {
      const id = this.messageId++;
      this.callbacks.set(id, resolve);
      this.ws?.send(JSON.stringify({ id, method, params }));
    });
  }

  handleMessage(msg: any) {
    if (msg.id && this.callbacks.has(msg.id)) {
      this.callbacks.get(msg.id)!(msg.result);
      this.callbacks.delete(msg.id);
    }
    
    if (msg.method === "Debugger.paused") {
      if (this.onPaused) this.onPaused(msg.params.callFrames);
    } else if (msg.method === "Debugger.resumed") {
      if (this.onResumed) this.onResumed();
    }
  }

  async resume() { await this.send("Debugger.resume"); }
  async stepOver() { await this.send("Debugger.stepOver"); }
  async stepInto() { await this.send("Debugger.stepInto"); }
  
  async setBreakpoint(filename: string, line: number): Promise<string> {
    const escapedFilename = filename.replace(/[-\/\\^$*+?.()|[\]{}]/g, "\\$&");
    const result = await this.send("Debugger.setBreakpointByUrl", {
      lineNumber: line - 1,
      urlRegex: `.*${escapedFilename}`,
    });
    return result.breakpointId;
  }

  async removeBreakpoint(breakpointId: string): Promise<any> {
    return await this.send("Debugger.removeBreakpoint", { breakpointId });
  }
  
  disconnect() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}

export const debuggerInstance = new DenoDebugger();
