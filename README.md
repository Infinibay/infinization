# Infinization

Custom virtualization solution for managing QEMU VMs, replacing libvirt dependency.

## Overview

Infinization provides TypeScript classes for building QEMU commands and managing VM process lifecycle. It offers a type-safe, fluent API that integrates with the Infinibay backend.

## IMPORTANT NOTE

This project is not mean to be used outside Infinibay proyect. It's too tied to many internals of the project. It requires several abstraction layers to decouple it.

## Features

- **Fluent API for QEMU command building**: Type-safe builder pattern for constructing QEMU command arrays
- **Safe process management**: Spawn-based process execution without shell injection risks
- **QMP socket support**: Management socket integration for VM control (future phases)
- **Storage management**: qemu-img wrapper for disk operations and snapshot management
- **State synchronization**: PostgreSQL integration for VM state tracking (future phases)
- **OS-specific driver presets**: Automatic optimization for Windows, Linux, and legacy operating systems
