import { Component, type ReactNode } from "react";
import "./ErrorBoundary.css";

interface Props {
  children: ReactNode;
  fallbackLabel?: string;
}

interface State {
  error: Error | null;
}

export class ViewErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: "2rem", color: "var(--color-text-secondary)", fontSize: 14 }}>
          <strong style={{ display: "block", marginBottom: 8 }}>
            {this.props.fallbackLabel ?? "此视图发生错误"}
          </strong>
          <code style={{ fontSize: 12, opacity: 0.7 }}>{this.state.error.message}</code>
        </div>
      );
    }

    return this.props.children;
  }
}
