import { Component, type ErrorInfo, type ReactNode } from "react";

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[ErrorBoundary] 渲染期间发生未捕获异常", error, info.componentStack);
  }

  private handleRetry = () => {
    this.setState({ error: null });
  };

  private handleReload = () => {
    window.location.reload();
  };

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="appErrorBoundary" role="alert">
        <div className="appErrorBoundaryCard">
          <h2>应用渲染异常</h2>
          <p>渲染过程中遇到未处理的错误，已暂时阻断渲染避免界面假死。详情请查看 DevTools 控制台。</p>
          <pre className="appErrorBoundaryStack">{error.stack ?? error.message}</pre>
          <div className="appErrorBoundaryActions">
            <button type="button" onClick={this.handleRetry}>
              重试渲染
            </button>
            <button type="button" onClick={this.handleReload}>
              重新加载
            </button>
          </div>
        </div>
      </div>
    );
  }
}
