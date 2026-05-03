import { characters, getRequestHeaders, this_chid } from '../../../../script.js';
import { callGenericPopup, POPUP_TYPE } from '../../../../popup.js';
import { getThumbnailUrl } from '../../../../utils.js';

// ==========================================
// 核心逻辑：唤起内置剪裁UI并处理结果
// ==========================================
async function openCropperAndSave(imageUrl, type, entityId) {
    try {
        // 1. 将图片转换为 Base64
        const response = await fetch(imageUrl);
        const blob = await response.blob();
        const base64Data = await new Promise((resolve) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result);
            reader.readAsDataURL(blob);
        });

        // 2. 唤出酒馆内置的剪裁 UI
        const croppedBase64 = await callGenericPopup("剪裁头像 (Crop Avatar)", POPUP_TYPE.CROP, '', { 
            cropAspect: 1, // 固定 1:1 比例
            cropImage: base64Data 
        });

        if (!croppedBase64) {
            return; // 用户点击了取消
        }

        // 3. 将剪裁后的 Base64 转回 File 对象
        const croppedBlob = await (await fetch(croppedBase64)).blob();
        const file = new File([croppedBlob], 'avatar.png', { type: 'image/png' });
        const formData = new FormData();

        // 4. 根据类型调用不同的 API 保存并覆盖原文件
        if (type === 'persona') {
            formData.append('avatar', file);
            formData.append('overwrite_name', entityId); // 这里的 entityId 是 avatarId
            await fetch('/api/avatars/upload', {
                method: 'POST',
                headers: getRequestHeaders({ omitContentType: true }),
                body: formData
            });
            toastr.success("用户头像已更新！");
            
            // 刷新缓存并重载
            await fetch(imageUrl, { cache: 'reload' });
            $('#user_avatar_block').empty(); // 触发重新渲染
            location.reload(); // 简单粗暴但有效，确保全局刷新
            
        } else if (type === 'character') {
            const char = characters.find(c => c.avatar === entityId);
            if (!char) return toastr.error("未找到角色数据");

            formData.append('avatar', file);
            formData.append('ch_name', char.name);
            // 【极其重要】必须附带现有的角色数据，否则覆盖图片会导致角色设定(V2卡片)丢失！
            formData.append('ch_data', JSON.stringify(char)); 

            await fetch('/api/characters/edit', {
                method: 'POST',
                headers: getRequestHeaders({ omitContentType: true }),
                body: formData
            });
            toastr.success("角色头像已更新！");
            
            await fetch(imageUrl, { cache: 'reload' });
            location.reload(); 
        }
    } catch (error) {
        console.error("Cropper Extension Error:", error);
        toastr.error("剪裁失败，请查看控制台。");
    }
}

// ==========================================
// 注入点 1: 聊天界面放大头像 (Zoomed Avatar)
// ==========================================
function setupZoomedAvatarObserver() {
    const observer = new MutationObserver((mutations) => {
        mutations.forEach((mut) => {
            mut.addedNodes.forEach((node) => {
                if (node.classList && node.classList.contains('zoomed_avatar')) {
                    // 检查是否已经添加过按钮
                    if (node.querySelector('.zoomed-avatar-crop-btn')) return;

                    const imgElement = node.querySelector('img');
                    if (!imgElement) return;

                    const imgSrc = imgElement.src;
                    
                    // 判断是 user 还是 character
                    let type = 'character';
                    let entityId = '';

                    if (imgSrc.includes('User%20Avatars') || imgSrc.includes('User Avatars')) {
                        type = 'persona';
                        // 提取文件名
                        entityId = decodeURIComponent(imgSrc.split('/').pop().split('?')[0]);
                    } else {
                        type = 'character';
                        entityId = decodeURIComponent(imgSrc.split('/').pop().split('?')[0]);
                    }

                    // 创建按钮
                    const cropBtn = document.createElement('button');
                    cropBtn.className = 'zoomed-avatar-crop-btn fa-solid fa-crop-simple';
                    cropBtn.title = '剪裁此头像';
                    
                    cropBtn.addEventListener('click', (e) => {
                        e.stopPropagation(); // 阻止点击穿透导致弹窗关闭
                        node.remove(); // 关掉放大视图
                        openCropperAndSave(imgSrc, type, entityId);
                    });

                    node.appendChild(cropBtn);
                }
            });
        });
    });

    observer.observe(document.body, { childList: true });
}

// ==========================================
// 注入点 2: 角色详情界面
// ==========================================
function injectCharacterSettingsButton() {
    // 监听角色设定面板的打开
    $(document).on('click', '.character_select', function () {
        setTimeout(() => {
            const controlsDiv = document.querySelector("#avatar_controls > div");
            if (controlsDiv && !controlsDiv.querySelector('.char-detail-crop-btn')) {
                const btn = document.createElement('div');
                btn.className = 'menu_button char-detail-crop-btn';
                btn.innerHTML = '<i class="fa-solid fa-crop-simple"></i> 剪裁';
                btn.title = "剪裁当前角色头像";
                
                btn.addEventListener('click', () => {
                    if (this_chid === undefined) return;
                    const char = characters[this_chid];
                    if (!char) return;
                    
                    const avatarUrl = `/characters/${char.avatar}`;
                    openCropperAndSave(avatarUrl, 'character', char.avatar);
                });

                controlsDiv.appendChild(btn);
            }
        }, 100); // 延迟一点等DOM渲染
    });
}

// ==========================================
// 注入点 3: Persona (User) 界面
// ==========================================
function injectPersonaButton() {
    // 因为 Persona 列表是动态渲染的，使用事件委托监听DOM变化或在鼠标悬浮时动态注入
    $(document).on('mouseenter', '#user_avatar_block .avatar-container', function() {
        const buttonsBlock = this.querySelector('.buttons_block');
        if (buttonsBlock && !buttonsBlock.querySelector('.persona-crop-btn')) {
            const avatarId = this.getAttribute('data-avatar-id');
            const btn = document.createElement('div');
            btn.className = 'menu_button inline-crop-btn persona-crop-btn';
            btn.innerHTML = '<i class="fa-solid fa-crop-simple"></i>';
            btn.title = "剪裁此 Persona 头像";
            
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const avatarUrl = `/User Avatars/${avatarId}`;
                openCropperAndSave(avatarUrl, 'persona', avatarId);
            });

            // 将按钮插入到按钮组的最前面或最后面
            buttonsBlock.prepend(btn);
        }
    });
}

// ==========================================
// 插件初始化
// ==========================================
jQuery(async () => {
    setupZoomedAvatarObserver();
    injectCharacterSettingsButton();
    injectPersonaButton();
    console.log("[Avatar Cropper] Extension loaded successfully!");
});
