//! Main driver for the build system.

mod build_config;
mod commands;
mod common;
mod daemon_config;
mod debian;
mod prebuilts;
mod tasks;
mod timer;

use crate::commands::{
    DevCommand, InstallCommand, ProdCommand, PushB2gCommand, PushCommand, ResetDataCommand,
    ResetTimeCommand, RestartCommand,
};
use crate::debian::DebianCommand;
use clap::{AppSettings, Parser, Subcommand};
use log::{error, info};
use thiserror::Error;

#[derive(Parser)]
#[clap(author, version, about, long_about = None)]
#[clap(global_setting(AppSettings::PropagateVersion))]
#[clap(global_setting(AppSettings::UseLongFormatForHelpSubcommand))]
struct Cli {
    #[clap(subcommand)]
    command: Commands,
    /// Enable verbose output.
    #[clap(long, short)]
    verbose: bool,
}

#[derive(Debug, Subcommand)]
enum Commands {
    /// Desktop: runs without packaging apps.
    Dev {
        /// The type of device to emulate. Valid values are 'desktop' and 'mobile'.
        #[clap(long)]
        r#type: Option<String>,
        /// The screen size to emulate. Formatted such as 800x600.
        #[clap(long)]
        size: Option<String>,
    },
    /// Desktop: runs with packaged apps.
    Prod {
        /// The type of device to emulate. Valid values are 'desktop' and 'mobile'.
        #[clap(long)]
        r#type: Option<String>,
        /// The screen size to emulate. Formatted such as 800x600.
        #[clap(long)]
        size: Option<String>,
    },
    /// Gonk: push the packaged apps to the device.
    Push {
        /// An optional comma separated list of apps.
        apps: Option<String>,
    },
    /// Gonk: push Gecko to the device.
    PushB2g {
        /// The full path to the Gecko package (eg. /home/user/b2g-98.0.en-US.linux-android-aarch64.tar.bz2)
        path: String,
    },
    /// Gonk: reset the user data on the device.
    ResetData {},
    /// Gonk: reset the time on device.
    ResetTime {},
    /// Gonk: force a restart of the api-daemon and b2g.
    Restart {},
    /// Desktop: package the apps into a given directory.
    Install {
        /// The root path of the packaged app, like /system/b2g/webapps on Gonk devices.
        path: String,
    },
    /// Desktop: creates a debian package.
    Deb {
        /// The device environment: desktop|pinephone, defaults to desktop.
        device: Option<String>,
    },
    /// Cleans up the output directory.
    Clean {},
    /// Download prebuilt versions of the needed binaries.
    UpdatePrebuilts {},
}

#[derive(Error, Debug)]
enum CommandError {
    #[error("Adb error: {0}")]
    Adb(#[from] crate::commands::AdbError),
    #[error("Io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("Configuration error: {0}")]
    Configuration(String),
    #[error("Desktop command error: {0}")]
    DesktopCommand(#[from] crate::common::DesktopCommandError),
    #[error("Debian command error: {0}")]
    DebianCommand(#[from] crate::debian::DebianError),
    #[error("Download task error: {0}")]
    DownloadTaskError(#[from] crate::prebuilts::DownloadTaskError),
}

fn main() {
    env_logger::init();

    let cli = Cli::parse();

    let mut display_info = cli.verbose;

    let mut config = build_config::BuildConfig::default();
    if let Err(err) = config.validate() {
        error!("Invalid configuration: {}", err);
        display_info = true;
    }

    if display_info {
        let s = "=".repeat(80);
        info!("{}", s);
        info!("Environment:");
        [
            "NUTRIA_OUPUT_ROOT",
            "NUTRIA_API_DAEMON_ROOT",
            "NUTRIA_API_DAEMON_BINARY",
            "NUTRIA_API_DAEMON_PORT",
            "NUTRIA_APPS_ROOT",
            "NUTRIA_APPSCMD_BINARY",
            "NUTRIA_B2GHALD_BINARY",
            "NUTRIA_B2G_BINARY",
            "NUTRIA_B2G_PACKAGE",
        ]
        .iter()
        .for_each(|name| {
            // 26 = length of NUTRIA_API_DAEMON_BINARY
            info!("{:26} = {}", name, std::env::var(name).unwrap_or_default());
        });

        info!("{}", s);
        info!("Configuration:");
        config.log();
        info!("{}", s);
    }

    // You can check for the existence of subcommands, and if found use their
    // matches just as you would the top level app
    let command_result: Result<(), CommandError> = match &cli.command {
        Commands::Prod { r#type, size } => {
            if config.set_output_name("prod").is_ok() {
                ProdCommand::start(config, r#type.clone(), size.clone()).map_err(|e| e.into())
            } else {
                Err(CommandError::Configuration(
                    "Failed to configure 'prod' build".into(),
                ))
            }
        }
        Commands::Dev { r#type, size } => {
            if config.set_output_name("dev").is_ok() {
                DevCommand::start(config, r#type.clone(), size.clone()).map_err(|e| e.into())
            } else {
                Err(CommandError::Configuration(
                    "Failed to configure 'dev' build".into(),
                ))
            }
        }
        Commands::ResetData {} => ResetDataCommand::start().map_err(|e| e.into()),
        Commands::ResetTime {} => ResetTimeCommand::start().map_err(|e| e.into()),
        Commands::Push { apps } => PushCommand::start(config, apps).map_err(|e| e.into()),
        Commands::PushB2g { path } => PushB2gCommand::start(path).map_err(|e| e.into()),
        Commands::Restart {} => RestartCommand::start().map_err(|e| e.into()),
        Commands::Install { path } => {
            if config.set_output_path(path).is_ok() {
                InstallCommand::start(config).map_err(|e| e.into())
            } else {
                Err(CommandError::Configuration(
                    "Failed to setup installation path.".into(),
                ))
            }
        }
        Commands::Deb { device } => {
            let output_path = config.output_path.join("debian").join("opt").join("b2gos");
            if config.set_output_path(&output_path).is_ok() {
                let device = match device {
                    Some(val) => val.clone(),
                    None => String::from("desktop"),
                };

                if device != "desktop" {
                    error!(
                        "Creating debian packages for '{}' is not supported.",
                        device
                    );
                    return;
                }

                config.daemon_port = 8081;
                DebianCommand::start(config, &device).map_err(|e| e.into())
            } else {
                Err(CommandError::Configuration(
                    "Failed to configure 'debian' build.".into(),
                ))
            }
        }
        Commands::Clean {} => {
            if let Err(err) = std::fs::remove_dir_all(&config.output_path) {
                error!(
                    "Failed to clean output directory {} : {}",
                    config.output_path.display(),
                    err
                );
                Err(CommandError::Io(err))
            } else {
                Ok(())
            }
        }
        Commands::UpdatePrebuilts {} => prebuilts::update(config).map_err(|e| e.into()),
    };

    if let Err(err) = command_result {
        error!("Command failed: {}", err);
    }
}
