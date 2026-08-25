import { sendInput, sendSplit } from "../net/socket";

export class InputManager {
  attach() {
    window.addEventListener("mousemove", this.onMouseMove);
    window.addEventListener("keydown", this.onKeyDown);
  }

  detach() {
    window.removeEventListener("mousemove", this.onMouseMove);
    window.removeEventListener("keydown", this.onKeyDown);
  }

  private onMouseMove = (e: MouseEvent) => {
    sendInput(e.clientX - window.innerWidth / 2, e.clientY - window.innerHeight / 2);
  };

  private onKeyDown = (e: KeyboardEvent) => {
    if (e.code === "Space") {
      e.preventDefault();
      sendSplit();
    }
  };
}
