import { extension_settings } from '../../../extensions.js';
import { saveSettingsDebounced } from '../../../../script.js';
import { callGenericPopup, POPUP_TYPE } from '../../../popup.js';

// 初始化数据结构
if (extension_settings.avatarClickZoomEnabled === undefined) extension_settings.avatarClickZoomEnabled = false;
// avatarCroppedImages 结构: { themeName: { avatarId: base64 } }
if (!extension_settings.avatarCroppedImages) extension_settings.avatarCroppedImages = {};
if (!extension_settings.altAvatars) extension_settings.altAvatars = {};

const GLOBAL_USER_KEY = '__GLOBAL_USER_GALLERY__';

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

function isUserAvatarSrc(src) {
    return src.includes('type=persona') || src.includes('User%20Avatars');
}

function getCurrentTheme() {
    const themeSelect = document.getElementById('themes');
    return themeSelect ? themeSelect.value : 'default';
}

// 记录当前真正有效的文件名（过滤掉临时 blob 路径）
let lastValidAvatarId = null;
setInterval(() => {
    const previewImg = document.getElementById('avatar_load_preview');
    if (previewImg) {
        const src = previewImg.getAttribute('src');
        if (src && !src.startsWith('blob:') && !src.startsWith('data:')) {
            lastValidAvatarId = getAvatarIdFromSrc(src);
        }
    }
}, 500);

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

/**
 * 触发酒馆原生上传替换机制
 */
async function triggerNativeUpload(base64Data, isUser) {
    try {
        const blob = await (await fetch(base64Data)).blob();
        const file = new File([blob], isUser ? "persona.png" : "character.png", { type: blob.type });
        
        const dataTransfer = new DataTransfer();
        dataTransfer.items.add(file);
        
        const inputId = isUser ? 'avatar_upload_file' : 'character_replace_file';
        const fileInput = document.getElementById(inputId);
        
        if (fileInput) {
            fileInput.files = dataTransfer.files;
            // 触发酒馆原生监听事件
            $(fileInput).trigger('change');
            toastr.success('已触发原生头像更新');
        }
    } catch (e) {
        console.error("[AvatarCropper] 原生上传失败:", e);
        toastr.error('头像替换失败');
    }
}

// ======================== CSS 生成引擎 ========================

// 注意：原先的替换卡面CSS（applyAltAvatars）已被废弃，因为我们现在直接调用原生上传更改实体文件。
// 我们只保留基于当前美化的剪裁CSS生成，并且限定在 #chat .mes (即聊天区域)
function applyCroppedAvatars() {
    const theme = getCurrentTheme();
    const croppedData = extension_settings.avatarCroppedImages[theme] || {};
    let cssString = '';
    
    for (const [avatarId, base64Image] of Object.entries(croppedData)) {
        if (avatarId === 'thumbnail') continue;

        const escapedId = avatarId.replace(/"/g, '\\"');
        const encodedId = encodeURIComponent(avatarId).replace(/"/g, '\\"');
        
        // 仅覆盖 .mes 里的头像，不影响全局和其他面板
        cssString += `
            #chat .mes .avatar img[src*="${escapedId}"],
            #chat .mes .avatar img[src*="${encodedId}"] {
                content: url("${base64Image}") !important;
                object-fit: cover !important;
            }
        `;
    }

    let styleTag = document.getElementById('custom-avatar-crop-style');
    if (!styleTag) {
        styleTag = document.createElement('style');
        styleTag.id = 'custom-avatar-crop-style';
        document.head.appendChild(styleTag);
    }
    styleTag.textContent = cssString;
}

function updateClickZoomState() {
    const isEnabled = !!extension_settings.avatarClickZoomEnabled;

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
}

// ======================== 图库面板 (Gallery) ========================

async function openGalleryPanel(imgSrc, isUser) {
    const originalAvatarId = getAvatarIdFromSrc(imgSrc);
    if (originalAvatarId === 'thumbnail' || imgSrc.startsWith('blob:')) {
        toastr.error('获取头像文件名失败或图片仍在加载，请稍后再试');
        return;
    }
    
    // User 使用全局 Key，Char 使用各自的 AvatarId
    const galleryKey = isUser ? GLOBAL_USER_KEY : originalAvatarId;
    
    if (!extension_settings.altAvatars[galleryKey]) {
        extension_settings.altAvatars[galleryKey] = { selected: null, images: [] };
    }
    const data = extension_settings.altAvatars[galleryKey];
    
    const html = `
        <div id="st-alt-avatar-panel">
            <div style="display:flex; justify-content:space-between; align-items:center; border-bottom: 1px solid var(--SmartThemeBodyColor, #555); padding-bottom: 10px;">
                <h3 style="margin: 0;">${isUser ? '全局User' : '角色'}图库</h3>
                <div style="display:flex; gap:10px; align-items:center;">
                    <div class="menu_button menu_button_icon margin0" id="btn-alt-upload" title="添加图片"><i class="fa-solid fa-upload"></i></div>
                    <div class="menu_button menu_button_icon margin0" id="btn-alt-manage" title="管理列表"><i class="fa-solid fa-trash-can"></i></div>
                    <div class="menu_button menu_button_icon margin0" id="btn-alt-delete-confirm" title="确认删除 (0)" style="display:none; color:#ff4444;"><i class="fa-solid fa-trash-can"></i></div>
                </div>
            </div>
            <input type="file" id="input-alt-upload" style="display:none;" accept="image/*" multiple>
            <div class="alt-avatar-grid" id="grid-alt-avatars"></div>
        </div>
    `;

    // 图库只做触发原生上传的动作，不需要通过确认按钮统一保存，因此关闭回调中无需额外逻辑
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
            btnDeleteConfirm.title = `确认删除 (${itemsToDelete.size})`;
        }

        function renderGrid() {
            grid.innerHTML = '';
            
            // 为了保证显示，如果 galleryKey 还没有原图备份，默认不显示原图卡片（因为原生机制已被触发）
            // 我们直接渲染 images 列表
            data.images.forEach((b64, index) => {
                const itemDiv = document.createElement('div');
                itemDiv.className = 'alt-avatar-item';
                if (data.selected === index) itemDiv.classList.add('selected');
                if (itemsToDelete.has(index)) itemDiv.classList.add('to-delete');
                
                itemDiv.innerHTML = `<img src="${b64}">`;
                itemDiv.onclick = async (e) => {
                    if (isDeleteMode) { 
                        e.stopPropagation(); 
                        toggleDeleteMark(index, itemDiv);
                    } else { 
                        // 点击切换：触发原生上传
                        data.selected = index;
                        saveSettingsDebounced();
                        renderGrid();
                        await triggerNativeUpload(b64, isUser);
                    }
                };
                grid.appendChild(itemDiv);
            });
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
                btnManage.title = '退出管理';
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
            if (itemsToDelete.size === 0) return btnManage.click();

            const confirm = await callGenericPopup(`是否确认删除选中的 ${itemsToDelete.size} 张图片？\n删除后相关的绑定数据也将清空。`, POPUP_TYPE.CONFIRM);
            if (!confirm) return;

            const indexes = Array.from(itemsToDelete).sort((a, b) => b - a);
            
            indexes.forEach((index) => {
                // 清理所有美化下对应的绑定数据（因为原图被删了）
                // 由于原生机制会导致 avatarId 改变，我们以删除动作为主
                const b64ToDelete = data.images[index];
                
                if (data.selected === index) data.selected = null;
                else if (data.selected > index) data.selected -= 1;
                
                data.images.splice(index, 1);
            });

            saveSettingsDebounced();
            
            // 如果最后一张都被删除了，恢复默认头像
            if (data.images.length === 0) {
                data.selected = null;
                toastr.warning('图库已空，恢复默认初始头像');
                const defaultFallback = isUser ? '/img/ai4.png' : '/img/ai2.png';
                const defaultB64 = await getBase64FromUrl(defaultFallback);
                await triggerNativeUpload(defaultB64, isUser);
            }

            btnManage.click(); 
            toastr.success('已成功删除选中图片');
        };
        
        btnUpload.onclick = () => inputUpload.click();
        
        inputUpload.onchange = async (e) => {
            const files = e.target.files;
            if (!files || files.length === 0) return;
            
            toastr.info(`正在处理 ${files.length} 张图片`);
            
            for(let i = 0; i < files.length; i++) {
                const b64 = await resizeImageToBase64(files[i]);
                data.images.push(b64);
            }
            
            saveSettingsDebounced();
            renderGrid();
            inputUpload.value = ''; 
            toastr.success('上传完成');
        };
        
        // 初始若为空，将当前预览的图存入第一张
        if (data.images.length === 0) {
            getBase64FromUrl(imgSrc).then(b64 => {
                data.images.push(b64);
                data.selected = 0;
                saveSettingsDebounced();
                renderGrid();
            });
        } else {
            renderGrid();
        }
    }, 100);
}

// ======================== 原生剪裁弹窗 ========================

async function triggerNativeCropPopup(imgSrc, avatarId) {
    const base64Original = await getBase64FromUrl(imgSrc);
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
        
        // 自动绑定到当前主题
        extension_settings.avatarCroppedImages[theme][avatarId] = croppedImageBase64;
        
        saveSettingsDebounced();
        applyCroppedAvatars(); 
        toastr.success('已剪裁并自动绑定至当前美化主题');
        
        // 尝试更新面板上绑定按钮的状态（如果还开着的话）
        const bindBtn = document.getElementById('st-native-bind-btn');
        if (bindBtn) bindBtn.classList.add('bind-active');
    }
}

// ======================== 控制按钮注入 ========================

function injectControlButtons(zoomedDiv) {
    if (zoomedDiv.querySelector('#st-native-crop-btn')) return;

    const controlBar = zoomedDiv.querySelector('.panelControlBar');
    if (!controlBar) return;

    const img = zoomedDiv.querySelector('img');
    if (!img) return;
    
    const imgSrc = img.src;
    const isUser = isUserAvatarSrc(imgSrc);
    const avatarId = getAvatarIdFromSrc(imgSrc);
    const theme = getCurrentTheme();

    // 1. 图库按钮
    const galleryBtn = document.createElement('div');
    galleryBtn.id = 'st-native-gallery-btn';
    galleryBtn.className = 'st-avatar-ctrl-btn';
    galleryBtn.innerHTML = '<i class="fa-solid fa-images"></i>';
    galleryBtn.title = isUser ? '全局 User 图库' : '角色专属图库';
    galleryBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        zoomedDiv.click(); // 关闭放大面板
        openGalleryPanel(imgSrc, isUser);
    });

    // 2. 剪裁按钮
    const cropBtn = document.createElement('div');
    cropBtn.id = 'st-native-crop-btn';
    cropBtn.className = 'st-avatar-ctrl-btn';
    cropBtn.innerHTML = '<i class="fa-solid fa-crop-simple"></i>';
    cropBtn.title = '剪裁头像 (仅应用于聊天区)';
    cropBtn.addEventListener('click', async (e) => {
        e.stopPropagation(); 
        zoomedDiv.click(); 
        await triggerNativeCropPopup(imgSrc, avatarId);
    });

    // 3. 绑定按钮
    const bindBtn = document.createElement('div');
    bindBtn.id = 'st-native-bind-btn';
    bindBtn.className = 'st-avatar-ctrl-btn';
    bindBtn.innerHTML = '<i class="fa-solid fa-link"></i>';
    bindBtn.title = '当前主题绑定状态 (点击解绑)';
    
    // 初始化绑定按钮状态
    const isBound = extension_settings.avatarCroppedImages[theme] && extension_settings.avatarCroppedImages[theme][avatarId];
    if (isBound) bindBtn.classList.add('bind-active');

    bindBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const currentTheme = getCurrentTheme();
        if (extension_settings.avatarCroppedImages[currentTheme] && extension_settings.avatarCroppedImages[currentTheme][avatarId]) {
            // 解除绑定
            delete extension_settings.avatarCroppedImages[currentTheme][avatarId];
            bindBtn.classList.remove('bind-active');
            toastr.info('已解除当前主题下的剪裁绑定，恢复默认。');
        } else {
            // 如果没有剪裁数据，提示需要先剪裁
            toastr.warning('请先点击剪裁按钮进行剪裁，剪裁后会自动绑定。');
        }
        saveSettingsDebounced();
        applyCroppedAvatars();
    });

    // 将按钮插入到关闭按钮之前
    const closeBtn = controlBar.querySelector('.dragClose');
    if (closeBtn) {
        controlBar.insertBefore(bindBtn, closeBtn);
        controlBar.insertBefore(cropBtn, bindBtn);
        controlBar.insertBefore(galleryBtn, cropBtn);
    } else {
        controlBar.appendChild(galleryBtn);
        controlBar.appendChild(cropBtn);
        controlBar.appendChild(bindBtn);
    }
}

// 监听主题切换，动态应用 CSS
let lastTheme = getCurrentTheme();
setInterval(() => {
    const currentTheme = getCurrentTheme();
    if (currentTheme !== lastTheme) {
        lastTheme = currentTheme;
        applyCroppedAvatars(); 
    }

    // 注入开启“点击头像放大”的选项（放置在UI设置处）
    try {
        const targetContainer = document.querySelector("#UI-Theme-Block > div.flex-container.flexFlowColumn.flexNoGap > div.flex-container.flexFlowColumn");
        if (targetContainer && !document.getElementById('st-avatar-features-toggle-container')) {
            const container = document.createElement('div');
            container.id = 'st-avatar-features-toggle-container';
            container.className = 'flex-container alignItemsBaseline';
            
            const isEnabled = !!extension_settings.avatarClickZoomEnabled;
            container.innerHTML = `
                <span data-i18n="Avatar Click Zoom">头像点击放大：</span>
                <select id="st-avatar-crop-select" class="widthNatural flex1 margin0 text_pole" title="开启后允许点击聊天界面的头像进行放大">
                    <option value="false" ${!isEnabled ? 'selected' : ''}>默认</option>
                    <option value="true" ${isEnabled ? 'selected' : ''}>启用</option>
                </select>
            `;
            targetContainer.appendChild(container);
            
            document.getElementById('st-avatar-crop-select').addEventListener('change', (e) => {
                extension_settings.avatarClickZoomEnabled = (e.target.value === 'true');
                saveSettingsDebounced();
                updateClickZoomState();
            });
        }
    } catch (e) { }
}, 1000);

jQuery(async () => {
    applyCroppedAvatars();
    updateClickZoomState();
    
    // 我们不再需要通过 body change 监听器去搞复杂的数据迁移，
    // 因为现在使用的是酒馆原生的文件上传，上传后文件名会改变，这是一种更干净的隔离。
    console.log('[AvatarCropper & Gallery] Successfully Loaded.');

    // 监听放大面板的出现
    const observer = new MutationObserver((mutations) => {
        mutations.forEach((mutation) => {
            mutation.addedNodes.forEach((node) => {
                if (node.nodeType === Node.ELEMENT_NODE) {
                    if (node.classList.contains('zoomed_avatar')) injectControlButtons(node);
                    else {
                        const zoomed = node.querySelector('.zoomed_avatar');
                        if (zoomed) injectControlButtons(zoomed);
                    }
                }
            });
        });
    });
    observer.observe(document.body, { childList: true, subtree: true });
});
