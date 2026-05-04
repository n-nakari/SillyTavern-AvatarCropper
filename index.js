import { extension_settings } from '../../../extensions.js';
import { saveSettingsDebounced } from '../../../../script.js';
import { callGenericPopup, POPUP_TYPE } from '../../../popup.js';

// 初始化数据结构
if (extension_settings.avatarCropEnabled === undefined) extension_settings.avatarCropEnabled = false;
if (!extension_settings.avatarCroppedImages) extension_settings.avatarCroppedImages = {};
if (!extension_settings.altAvatars) extension_settings.altAvatars = {};

function getAvatarIdFromSrc(src) {
    try {
        const urlObj = new URL(src, window.location.origin);
        const fileParam = urlObj.searchParams.get('file') || urlObj.searchParams.get('avatar');
        if (fileParam) return decodeURIComponent(fileParam);
        
        const parts = urlObj.pathname.split('/');
        let filename = parts[parts.length - 1];
        return decodeURIComponent(filename);
    } catch (e) {
        let cleanSrc = src.split('?')[0];
        const parts = cleanSrc.split('/');
        return decodeURIComponent(parts[parts.length - 1]);
    }
}

function getCurrentTheme() {
    const themeSelect = document.getElementById('themes');
    return themeSelect ? themeSelect.value : 'default';
}

async function resizeImageToBase64(file) {
    return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = (e) => {
            const img = new Image();
            img.onload = () => {
                const canvas = document.createElement('canvas');
                const MAX_SIZE = 800; 
                let width = img.width;
                let height = img.height;
                if (width > height && width > MAX_SIZE) {
                    height *= MAX_SIZE / width;
                    width = MAX_SIZE;
                } else if (height > MAX_SIZE) {
                    width *= MAX_SIZE / height;
                    height = MAX_SIZE;
                }
                canvas.width = width;
                canvas.height = height;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, width, height);
                resolve(canvas.toDataURL('image/jpeg', 0.85)); 
            };
            img.src = e.target.result;
        };
        reader.readAsDataURL(file);
    });
}

async function getBase64FromUrl(url) {
    if (url.startsWith('data:image')) return url;
    const data = await fetch(url);
    const blob = await data.blob();
    return new Promise((resolve) => {
        const reader = new FileReader();
        reader.readAsDataURL(blob); 
        reader.onloadend = () => resolve(reader.result);
    });
}

// ======================== CSS 生成引擎 ========================

function applyAltAvatars() {
    let cssString = '';
    for (const [avatarId, data] of Object.entries(extension_settings.altAvatars)) {
        if (avatarId === 'thumbnail') continue; 

        if (data.selected !== null && data.images[data.selected]) {
            const escapedId = avatarId.replace(/"/g, '\\"');
            const encodedId = encodeURIComponent(avatarId).replace(/"/g, '\\"');
            const b64 = data.images[data.selected];

            cssString += `
                .avatar img[src*="${escapedId}"],
                .avatar img[src*="${encodedId}"],
                #avatar_load_preview[src*="${escapedId}"],
                #avatar_load_preview[src*="${encodedId}"],
                .zoomed_avatar img[src*="${escapedId}"],
                .zoomed_avatar img[src*="${encodedId}"] {
                    content: url("${b64}") !important;
                    object-fit: cover !important;
                }
            `;
        }
    }

    let styleTag = document.getElementById('custom-alt-avatar-style');
    if (!styleTag) {
        styleTag = document.createElement('style');
        styleTag.id = 'custom-alt-avatar-style';
        document.head.appendChild(styleTag);
    }
    styleTag.textContent = cssString;
}

function applyCroppedAvatars() {
    const theme = getCurrentTheme();
    const croppedData = extension_settings.avatarCroppedImages[theme] || {};
    let cssString = '';
    
    if (extension_settings.avatarCropEnabled) {
        for (const [avatarId, base64Image] of Object.entries(croppedData)) {
            if (avatarId === 'thumbnail') continue;

            const escapedId = avatarId.replace(/"/g, '\\"');
            const encodedId = encodeURIComponent(avatarId).replace(/"/g, '\\"');
            cssString += `
                .avatar img[src*="${escapedId}"],
                .avatar img[src*="${encodedId}"] {
                    content: url("${base64Image}") !important;
                    object-fit: cover !important;
                }
            `;
        }
    }

    let styleTag = document.getElementById('custom-avatar-crop-style');
    if (!styleTag) {
        styleTag = document.createElement('style');
        styleTag.id = 'custom-avatar-crop-style';
        document.head.appendChild(styleTag);
    }
    styleTag.textContent = cssString;
}

function updateAvatarFeaturesState() {
    const isEnabled = !!extension_settings.avatarCropEnabled;

    let pointerStyle = document.getElementById('st-avatar-crop-pointer-events');
    if (isEnabled) {
        if (!pointerStyle) {
            pointerStyle = document.createElement('style');
            pointerStyle.id = 'st-avatar-crop-pointer-events';
            document.head.appendChild(pointerStyle);
        }
        pointerStyle.textContent = `
            #chat .mes .mesAvatarWrapper .avatar, 
            #chat .mes .mesAvatarWrapper .avatar img {
                pointer-events: auto !important;
            }
        `;
    } else if (pointerStyle) {
        pointerStyle.remove();
    }

    applyCroppedAvatars();
}

// ======================== 替换卡面面板 (多选上传、多选删除) ========================

async function openAltAvatarPanel() {
    const previewImg = document.getElementById('avatar_load_preview');
    if (!previewImg || !previewImg.getAttribute('src')) {
        toastr.warning('请先在侧边栏选择一个角色！');
        return;
    }
    
    const originalSrc = previewImg.getAttribute('src');
    const avatarId = getAvatarIdFromSrc(originalSrc);
    
    if (avatarId === 'thumbnail') {
        toastr.error('获取头像文件名失败，无法开启替换功能。');
        return;
    }
    
    if (!extension_settings.altAvatars[avatarId]) {
        extension_settings.altAvatars[avatarId] = { selected: null, images: [] };
    }
    const data = extension_settings.altAvatars[avatarId];
    
    const html = `
        <div id="st-alt-avatar-panel">
            <div style="display:flex; justify-content:space-between; align-items:center; border-bottom: 1px solid var(--SmartThemeBorderColor, #555); padding-bottom: 10px;">
                <h3 style="margin: 0;">替换卡面</h3>
                <div style="display:flex; gap:10px; align-items:center;">
                    <div class="menu_button menu_button_icon margin0" id="btn-alt-upload" title="上传图片"><i class="fa-solid fa-upload"></i></div>
                    <div class="menu_button menu_button_icon margin0" id="btn-alt-manage" title="管理列表"><i class="fa-solid fa-trash-can"></i></div>
                    <div class="menu_button menu_button_icon margin0" id="btn-alt-delete-confirm" title="确认删除" style="display:none; color:#ff4444;"><i class="fa-solid fa-check"></i> 确认删除(0)</div>
                </div>
            </div>
            <!-- 支持多选的 input -->
            <input type="file" id="input-alt-upload" style="display:none;" accept="image/*" multiple>
            <div class="alt-avatar-grid" id="grid-alt-avatars"></div>
        </div>
    `;
    
    callGenericPopup(html, POPUP_TYPE.TEXT, '', { wide: true, large: true });
    
    setTimeout(() => {
        const grid = document.getElementById('grid-alt-avatars');
        if(!grid) return;

        const btnUpload = document.getElementById('btn-alt-upload');
        const btnManage = document.getElementById('btn-alt-manage');
        const btnDeleteConfirm = document.getElementById('btn-alt-delete-confirm');
        const inputUpload = document.getElementById('input-alt-upload');
        
        let isDeleteMode = false;
        let itemsToDelete = new Set();
        
        function updateDeleteConfirmBtn() {
            btnDeleteConfirm.innerHTML = `<i class="fa-solid fa-check"></i> 确认删除(${itemsToDelete.size})`;
            if(itemsToDelete.size > 0) {
                btnDeleteConfirm.style.color = '#ff4444';
            } else {
                btnDeleteConfirm.style.color = 'var(--SmartThemeTextColor, #fff)';
            }
        }

        function renderGrid() {
            grid.innerHTML = '';
            
            const origDiv = document.createElement('div');
            origDiv.className = 'alt-avatar-item original-item' + (data.selected === null ? ' selected' : '');
            origDiv.innerHTML = `<img src="${originalSrc}" title="默认卡面" onerror="this.src='img/ai4.png'">`;
            origDiv.onclick = () => selectAvatar(null);
            grid.appendChild(origDiv);
            
            data.images.forEach((b64, index) => {
                const itemDiv = document.createElement('div');
                itemDiv.className = 'alt-avatar-item' + (data.selected === index ? ' selected' : '');
                if (itemsToDelete.has(index)) itemDiv.classList.add('to-delete');
                
                itemDiv.innerHTML = `<img src="${b64}">`;
                itemDiv.onclick = (e) => {
                    if (isDeleteMode) { 
                        e.stopPropagation(); 
                        toggleDeleteMark(index, itemDiv);
                    } else { 
                        selectAvatar(index); 
                    }
                };
                grid.appendChild(itemDiv);
            });
        }
        
        function selectAvatar(index) {
            if (isDeleteMode) return;
            data.selected = index;
            
            const theme = getCurrentTheme();
            if (extension_settings.avatarCroppedImages && extension_settings.avatarCroppedImages[theme]) {
                delete extension_settings.avatarCroppedImages[theme][avatarId];
            }
            
            saveSettingsDebounced();
            applyAltAvatars();
            applyCroppedAvatars(); 
            renderGrid();
        }
        
        function toggleDeleteMark(index, element) {
            if (itemsToDelete.has(index)) {
                itemsToDelete.delete(index);
                element.classList.remove('to-delete');
            } else {
                itemsToDelete.add(index);
                element.classList.add('to-delete');
            }
            updateDeleteConfirmBtn();
        }
        
        btnManage.onclick = () => {
            isDeleteMode = !isDeleteMode;
            if (isDeleteMode) {
                btnManage.innerHTML = '<i class="fa-solid fa-xmark"></i>';
                btnManage.title = '取消管理';
                btnUpload.style.display = 'none';
                btnDeleteConfirm.style.display = 'flex';
                itemsToDelete.clear();
                updateDeleteConfirmBtn();
            } else {
                btnManage.innerHTML = '<i class="fa-solid fa-trash-can"></i>';
                btnManage.title = '管理列表';
                btnUpload.style.display = 'flex';
                btnDeleteConfirm.style.display = 'none';
                itemsToDelete.clear();
            }
            grid.classList.toggle('delete-mode', isDeleteMode);
            renderGrid();
        };

        btnDeleteConfirm.onclick = async () => {
            if (itemsToDelete.size === 0) return btnManage.click(); // 如果没选任何东西，直接退出管理模式

            const confirm = await callGenericPopup(`确认删除选中的 ${itemsToDelete.size} 张卡面吗？`, POPUP_TYPE.CONFIRM);
            if (!confirm) return;

            // 将索引降序排列，从后往前删，避免索引偏移导致错乱
            const indexes = Array.from(itemsToDelete).sort((a, b) => b - a);
            
            indexes.forEach((index) => {
                if (data.selected === index) {
                    data.selected = null;
                } else if (data.selected > index) {
                    data.selected -= 1;
                }
                data.images.splice(index, 1);
            });

            saveSettingsDebounced();
            applyAltAvatars();
            
            btnManage.click(); // 退出管理模式
            toastr.success('已成功删除选中卡面');
        };
        
        btnUpload.onclick = () => inputUpload.click();
        
        inputUpload.onchange = async (e) => {
            const files = e.target.files;
            if (!files || files.length === 0) return;
            
            toastr.info(`正在处理 ${files.length} 张图片，请稍候...`);
            
            for(let i = 0; i < files.length; i++) {
                const b64 = await resizeImageToBase64(files[i]);
                data.images.push(b64);
            }
            
            saveSettingsDebounced();
            renderGrid();
            inputUpload.value = ''; // 清空方便下次选择
            toastr.success('所有图片上传完成！');
        };
        
        renderGrid();
    }, 100);
}

// ======================== 原生剪裁弹窗 ========================

async function triggerNativeCropPopup(imgSrc) {
    const avatarId = getAvatarIdFromSrc(imgSrc);
    if (avatarId === 'thumbnail') return toastr.error('图片获取异常，无法剪裁');

    let base64Original;
    if (extension_settings.altAvatars[avatarId] && extension_settings.altAvatars[avatarId].selected !== null) {
        const altData = extension_settings.altAvatars[avatarId];
        base64Original = altData.images[altData.selected];
    } else {
        base64Original = await getBase64FromUrl(imgSrc);
    }

    const cropPromise = callGenericPopup('', POPUP_TYPE.CROP, '', { cropAspect: 0, cropImage: base64Original });

    setTimeout(() => {
        const cropperImg = document.querySelector('#dialogue_popup .cropper-hidden');
        if (cropperImg && cropperImg.cropper) {
            const cropper = cropperImg.cropper;
            cropper.setDragMode('move');
            cropper.options.wheelZoomRatio = 0.05;
        }
    }, 150);

    const croppedImageBase64 = await cropPromise;

    if (croppedImageBase64) {
        const theme = getCurrentTheme(); 
        if (!extension_settings.avatarCroppedImages[theme]) extension_settings.avatarCroppedImages[theme] = {};
        extension_settings.avatarCroppedImages[theme][avatarId] = croppedImageBase64;
        
        saveSettingsDebounced();
        applyCroppedAvatars(); 
        toastr.success('头像剪裁已保存');
    }
}

function injectCropButton(zoomedDiv) {
    if (!extension_settings.avatarCropEnabled) return;
    if (zoomedDiv.querySelector('#st-native-crop-btn')) return;

    const controlBar = zoomedDiv.querySelector('.panelControlBar');
    if (!controlBar) return;

    const btn = document.createElement('div');
    btn.id = 'st-native-crop-btn';
    btn.innerHTML = '<i class="fa-solid fa-crop-simple"></i>';
    btn.title = '剪裁头像';

    btn.addEventListener('click', async (e) => {
        e.stopPropagation(); 
        const img = zoomedDiv.querySelector('img');
        if (img) {
            zoomedDiv.click(); 
            await triggerNativeCropPopup(img.src);
        }
    });

    const closeBtn = controlBar.querySelector('.dragClose');
    if (closeBtn) controlBar.insertBefore(btn, closeBtn);
    else controlBar.appendChild(btn);
}

let lastTheme = getCurrentTheme();

setInterval(() => {
    const currentTheme = getCurrentTheme();
    if (currentTheme !== lastTheme) {
        lastTheme = currentTheme;
        applyCroppedAvatars(); 
    }

    try {
        const targetContainer = document.querySelector("#UI-Theme-Block > div.flex-container.flexFlowColumn.flexNoGap > div.flex-container.flexFlowColumn");
        
        if (targetContainer && !document.getElementById('st-avatar-features-toggle-container')) {
            const container = document.createElement('div');
            container.id = 'st-avatar-features-toggle-container';
            container.className = 'flex-container alignItemsBaseline';
            
            const isEnabled = !!extension_settings.avatarCropEnabled;
            
            container.innerHTML = `
                <span data-i18n="Avatar Crop">头像剪裁：</span>
                <select id="st-avatar-crop-select" class="widthNatural flex1 margin0 text_pole" title="开启后允许点击放大后的头像进行高级剪裁">
                    <option value="true" ${isEnabled ? 'selected' : ''}>启用</option>
                    <option value="false" ${!isEnabled ? 'selected' : ''}>禁用</option>
                </select>
            `;
            targetContainer.appendChild(container);
            
            document.getElementById('st-avatar-crop-select').addEventListener('change', (e) => {
                extension_settings.avatarCropEnabled = (e.target.value === 'true');
                saveSettingsDebounced();
                updateAvatarFeaturesState();
            });
        }
    } catch (e) { }

    try {
        const avatarControls = document.querySelector('#avatar_controls > .form_create_bottom_buttons_block');
        if (avatarControls && !document.getElementById('st-alt-avatar-btn')) {
            const btn = document.createElement('div');
            btn.id = 'st-alt-avatar-btn';
            btn.className = 'menu_button menu_button_icon';
            btn.innerHTML = '<i class="fa-solid fa-images"></i>';
            btn.title = '替换卡面 (为当前角色独立管理新头像)';
            btn.addEventListener('click', openAltAvatarPanel);
            
            avatarControls.prepend(btn);
        }
    } catch (e) {}
}, 1000);

jQuery(async () => {
    applyAltAvatars();
    updateAvatarFeaturesState();
    
    console.log('[AvatarCropper] Successfully Loaded with Safety Checks.');

    const observer = new MutationObserver((mutations) => {
        mutations.forEach((mutation) => {
            mutation.addedNodes.forEach((node) => {
                if (node.nodeType === Node.ELEMENT_NODE) {
                    if (node.classList.contains('zoomed_avatar')) injectCropButton(node);
                    else {
                        const zoomed = node.querySelector('.zoomed_avatar');
                        if (zoomed) injectCropButton(zoomed);
                    }
                }
            });
        });
    });
    observer.observe(document.body, { childList: true, subtree: true });
});
