## Host Setup Guide: AMD Strix Halo (Ryzen AI MAX+ 395) LLM Server

### Hardware

- AMD Ryzen AI MAX+ 395 with Radeon 8060S (gfx1151)
- 128GB unified memory

### OS

- Ubuntu 24.04 LTS (Noble)

### BIOS & Boot Configuration (to get ~108GB+ VRAM)

**A. Disable IOMMU** in BIOS

**B. Set VRAM to minimum** in BIOS (lets the AMDGPU driver dynamically allocate up to maximum)

**C. Set kernel boot parameters:**

```bash
sudo vi /etc/default/grub
# Change to:
GRUB_CMDLINE_LINUX_DEFAULT="quiet splash amd_iommu=off amdttm.pages_limit=27648000 amdttm.page_pool_size=27648000"

sudo update-grub
sudo reboot
```

**D. (Optional) Disable GUI** to free memory:

```bash
sudo systemctl set-default multi-user.target
# Re-enable later: sudo systemctl set-default graphical.target
```

**Verify:**

```bash
cat /sys/class/drm/card*/device/mem_info_gtt_total   # should show ~120GB
sudo dmesg | grep -E "amdgpu.*GTT"                    # "120000M of GTT memory ready"
```

### GPU Driver (on host)

```bash
wget https://repo.radeon.com/amdgpu-install/7.0.2/ubuntu/noble/amdgpu-install_7.0.2.70002-1_all.deb
sudo apt install ./amdgpu-install_7.0.2.70002-1_all.deb
sudo apt update
sudo apt install python3-setuptools python3-wheel
sudo apt install "linux-headers-$(uname -r)" "linux-modules-extra-$(uname -r)"
sudo apt install rocm amdgpu-dkms
sudo usermod -a -G render,video $LOGNAME
```

Verify with `rocminfo | grep gfx` → should show `gfx1151`.
