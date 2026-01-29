import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const LOG_FILE = path.join(os.tmpdir(), "obsidian-cursor.log");
const MAX_LOG_SIZE = 5 * 1024 * 1024; // 5MB

export type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";

class Logger {
  private source: string;

  constructor(source: string) {
    this.source = source;
  }

  private formatMessage(level: LogLevel, message: string): string {
    const now = new Date();
    const timestamp = now.toISOString().replace("T", " ").replace("Z", "");
    return `[${timestamp}] [${this.source}] [${level}] ${message}\n`;
  }

  private write(level: LogLevel, message: string): void {
    const formatted = this.formatMessage(level, message);
    
    try {
      // Check file size and truncate if too large
      if (fs.existsSync(LOG_FILE)) {
        const stats = fs.statSync(LOG_FILE);
        if (stats.size > MAX_LOG_SIZE) {
          // Keep last half of the file
          const content = fs.readFileSync(LOG_FILE, "utf8");
          const lines = content.split("\n");
          const halfLines = lines.slice(Math.floor(lines.length / 2));
          fs.writeFileSync(LOG_FILE, halfLines.join("\n"));
        }
      }
      
      fs.appendFileSync(LOG_FILE, formatted);
    } catch {
      // Silently fail if we can't write to log
    }
  }

  debug(message: string): void {
    this.write("DEBUG", message);
  }

  info(message: string): void {
    this.write("INFO", message);
  }

  warn(message: string): void {
    this.write("WARN", message);
  }

  error(message: string): void {
    this.write("ERROR", message);
  }
}

export const logger = new Logger("OBS");
