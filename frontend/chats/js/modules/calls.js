/**
 * Модуль для управления голосовыми и видео звонками через WebRTC
 * Поддерживает приватные звонки и аудио-чаты (как Clubhouse/Discord stage)
 */

class CallManager {
  constructor(websocket, currentUserEmail) {
    this.ws = websocket;
    this.currentUserEmail = currentUserEmail;
    this.peerConnection = null; // Для приватных звонков
    this.localStream = null;
    this.remoteStream = null; // Для приватных звонков
    this.currentCall = null; // {call_id, chat_id, type, role: 'caller'|'callee'}
    // STUN по умолчанию; TURN подгружается через getIceServers() — критично для звонков через интернет
    this.defaultIceServers = [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun2.l.google.com:19302' }
    ];
    this.iceServersCache = null; // кэш от API (STUN+TURN)
    this.pendingPrivateIceCandidates = []; // ICE кандидаты до установки remote description (приватные звонки)
    
    // Аудио-чаты
    this.currentAudioChat = null; // {audio_room_id, chat_id, participants}
    this.audioChatPeerConnections = new Map(); // email -> RTCPeerConnection
    this.audioChatRemoteStreams = new Map(); // email -> MediaStream
    this.pendingAudioChat = null; // Данные ожидающего аудио-чата для баннера
    this.audioChatParticipantsData = new Map(); // email -> {name, avatar}
    this.pendingIceCandidates = new Map(); // email -> [candidates] - кандидаты, ожидающие установки remote description
    
    // Callback для обновления UI статуса соединения
    this.onConnectionStateChange = null;
  }

  // === ИСПРАВЛЕНИЕ: ДОБАВЛЯЕМ ЭТОТ БЛОК СЮДА ===
  /**
   * Маршрутизатор всех WebSocket сообщений для звонков
   */
  handleWebSocketMessage(data) {
    console.log('[Calls] Обработка WS сообщения:', data.type);
    switch (data.type) {
      // --- Приватные звонки ---
      case 'incoming_call':
        this.handleIncomingCall(data);
        break;
      case 'call_accepted':
        // Собеседник принял вызов — мы как инициатор создаем WebRTC Offer
        this.createAndSendOffer();
        this.showActiveCallUI();
        break;
      case 'call_rejected':
      case 'call_ended':
        this.cleanup();
        this.hideCallUI();
        break;
      case 'call_offer':
        this.handleOffer(data.offer);
        this.showActiveCallUI();
        break;
      case 'call_answer':
        this.handleAnswer(data.answer);
        break;
      case 'call_ice_candidate':
        this.handleIceCandidate(data.candidate);
        break;

      // --- Аудио-чаты (группы) ---
      case 'audio_chat_created':
        this.showAudioChatBanner(data);
        break;
      case 'audio_chat_joined':
        this.handleAudioChatJoined(data);
        break;
      case 'audio_chat_participant_joined':
        this.handleParticipantJoined(data.participant_email, data.participants);
        break;
      case 'audio_chat_participant_left':
        this.handleParticipantLeft(data.participant_email);
        break;
      case 'audio_chat_ended':
        this.cleanupAudioChat();
        this.hideAudioChatUI();
        break;
      case 'audio_chat_offer':
        this.handleAudioChatOffer(data.offer, data.from_email);
        break;
      case 'audio_chat_answer':
        this.handleAudioChatAnswer(data.answer, data.from_email);
        break;
      case 'audio_chat_ice_candidate':
        this.handleAudioChatIceCandidate(data.candidate, data.from_email);
        break;
    }
  }

  /** Чистые настройки микрофона без лишней обработки — убирает писк и артефакты */
  getAudioConstraints(video = false) {
    return {
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1
      },
      video
    };
  }

  /**
   * Получает ICE серверы (STUN+TURN). Кэширует результат. TURN критичен для звонков между разными сетями.
   */
  async getIceServers() {
    if (this.iceServersCache) return this.iceServersCache;
    try {
      const base = window.location.origin;
      const res = await fetch(`${base}/api/webrtc-ice-servers`);
      if (res.ok) {
        const data = await res.json();
        if (data.iceServers && Array.isArray(data.iceServers) && data.iceServers.length > 0) {
          this.iceServersCache = data.iceServers;
          console.log('[Calls] Loaded ICE servers from API:', data.iceServers.length);
          return this.iceServersCache;
        }
      }
    } catch (e) {
      console.warn('[Calls] Failed to fetch ICE servers, using defaults:', e);
    }
    this.iceServersCache = this.defaultIceServers;
    return this.iceServersCache;
  }

  /**
   * Инициирует приватный звонок
   */
  async initiateCall(chatId, callType = 'audio') {
    if (this.currentCall) {
      console.warn('[Calls] Call already in progress');
      this.showActiveCallUI();
      return false;
    }

    try {
      this.localStream = await navigator.mediaDevices.getUserMedia(
        this.getAudioConstraints(callType === 'video')
      );
      
      const iceServers = await this.getIceServers();
      this.peerConnection = new RTCPeerConnection({
        iceServers,
        iceCandidatePoolSize: 10,
        bundlePolicy: 'max-bundle',
        rtcpMuxPolicy: 'require'
      });

      // Добавляем локальные треки
      this.localStream.getTracks().forEach(track => {
        this.peerConnection.addTrack(track, this.localStream);
      });

      this.peerConnection.onicecandidate = (event) => {
        if (event.candidate && this.currentCall) {
          this.sendIceCandidate(event.candidate);
        }
      };

      this.peerConnection.ontrack = (event) => {
        console.log('[Calls] Track received:', event);
        if (event.streams && event.streams.length > 0) {
          const stream = event.streams[0];
          // Убеждаемся, что все аудио треки включены
          stream.getAudioTracks().forEach(track => {
            track.enabled = true;
            console.log('[Calls] Audio track:', track.id, 'enabled:', track.enabled, 'readyState:', track.readyState);
          });
          this.remoteStream = stream;
          this.onRemoteStreamReceived(this.remoteStream);
        } else if (event.track) {
          // Если потока нет, создаем новый поток из трека
          const stream = new MediaStream([event.track]);
          event.track.enabled = true;
          this.remoteStream = stream;
          this.onRemoteStreamReceived(this.remoteStream);
        }
      };

      this.peerConnection.onconnectionstatechange = () => {
        console.log('[Calls] Connection state:', this.peerConnection.connectionState);
        
        // Уведомляем UI о смене статуса
        if (this.onConnectionStateChange) {
          this.onConnectionStateChange(this.peerConnection.connectionState);
        }

        if (this.peerConnection.connectionState === 'failed' || 
            this.peerConnection.connectionState === 'disconnected') {
          this.handleConnectionError();
        }
      };
      
      const callId = this.generateCallId();

      this.ws.send(JSON.stringify({
        type: 'call_initiate',
        chat_id: chatId,
        call_type: callType,
        call_id: callId
      }));

      this.currentCall = {
        call_id: callId,
        chat_id: chatId,
        type: callType,
        role: 'caller',
        status: 'ringing'
      };

      this.showCallingUI();
      return true;
    } catch (error) {
      console.error('[Calls] Error initiating call:', error);
      this.cleanup();
      return false;
    }
  }

  /**
   * Обрабатывает входящий приватный звонок
   */
  async handleIncomingCall(callData) {
    if (this.currentCall) {
      if (callData.call_id) {
        this.rejectCall(callData.call_id);
      }
      return;
    }

    this.currentCall = {
      call_id: callData.call_id,
      chat_id: callData.chat_id,
      type: callData.call_type,
      role: 'callee'
    };

    this.showIncomingCallUI(callData);
  }

  /**
   * Принимает входящий приватный звонок
   */
  async acceptCall(callId) {
    if (!this.currentCall || this.currentCall.call_id !== callId) {
      console.warn('[Calls] Call not found');
      return;
    }

    try {
      this.localStream = await navigator.mediaDevices.getUserMedia(
        this.getAudioConstraints(this.currentCall.type === 'video')
      );

      const iceServers = await this.getIceServers();
      this.peerConnection = new RTCPeerConnection({
        iceServers,
        iceCandidatePoolSize: 10,
        bundlePolicy: 'max-bundle',
        rtcpMuxPolicy: 'require'
      });

      this.pendingPrivateIceCandidates = [];

      this.localStream.getTracks().forEach(track => {
        if (track.readyState === 'live') {
          this.peerConnection.addTrack(track, this.localStream);
        }
      });

      this.peerConnection.onicecandidate = (event) => {
        if (event.candidate) {
          this.sendIceCandidate(event.candidate);
        }
      };

      this.peerConnection.ontrack = (event) => {
        console.log('[Calls] Track received:', event);
        if (event.streams && event.streams.length > 0) {
          const stream = event.streams[0];
          // Убеждаемся, что все аудио треки включены
          stream.getAudioTracks().forEach(track => {
            track.enabled = true;
            console.log('[Calls] Audio track:', track.id, 'enabled:', track.enabled, 'readyState:', track.readyState);
          });
          this.remoteStream = stream;
          this.onRemoteStreamReceived(this.remoteStream);
        } else if (event.track) {
          // Если потока нет, создаем новый поток из трека
          const stream = new MediaStream([event.track]);
          event.track.enabled = true;
          this.remoteStream = stream;
          this.onRemoteStreamReceived(this.remoteStream);
        }
      };

      this.peerConnection.onconnectionstatechange = () => {
        console.log('[Calls] Connection state:', this.peerConnection.connectionState);
        
        // Уведомляем UI о смене статуса
        if (this.onConnectionStateChange) {
          this.onConnectionStateChange(this.peerConnection.connectionState);
        }

        if (this.peerConnection.connectionState === 'failed' || 
            this.peerConnection.connectionState === 'disconnected') {
          this.handleConnectionError();
        }
      };

      this.ws.send(JSON.stringify({
        type: 'call_accept',
        call_id: callId
      }));
    } catch (error) {
      console.error('[Calls] Error accepting call:', error);
      this.rejectCall(callId);
    }
  }

  /**
   * Отклоняет приватный звонок
   */
  rejectCall(callId) {
    this.ws.send(JSON.stringify({
      type: 'call_reject',
      call_id: callId
    }));
    this.cleanup();
    this.hideCallUI();
  }

  /**
   * Завершает приватный звонок
   */
  endCall() {
    if (this.currentCall) {
      this.ws.send(JSON.stringify({
        type: 'call_end',
        call_id: this.currentCall.call_id
      }));
    }
    this.cleanup();
    this.hideCallUI();
  }

  /**
   * Обрабатывает SDP offer для приватных звонков
   */
  async handleOffer(offer, fromEmail = null) {
    if (!this.peerConnection) {
      console.warn('[Calls] No peer connection');
      return;
    }

    try {
      // Убеждаемся, что локальные треки добавлены перед обработкой offer
      if (this.localStream) {
        const senders = this.peerConnection.getSenders();
        const hasAudioTrack = senders.some(sender => sender.track && sender.track.kind === 'audio');
        if (!hasAudioTrack) {
          this.localStream.getTracks().forEach(track => {
            if (track.readyState === 'live') {
              this.peerConnection.addTrack(track, this.localStream);
            }
          });
        }
      }

      await this.peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
      await this.processPendingPrivateIceCandidates();
      const answer = await this.peerConnection.createAnswer();
      await this.peerConnection.setLocalDescription(answer);
      
      this.ws.send(JSON.stringify({
        type: 'call_answer',
        call_id: this.currentCall.call_id,
        answer: answer
      }));
    } catch (error) {
      console.error('[Calls] Error handling offer:', error);
      this.endCall();
    }
  }

  /**
   * Обрабатывает SDP answer для приватных звонков
   */
  async handleAnswer(answer, fromEmail = null) {
    if (!this.peerConnection) {
      console.warn('[Calls] No peer connection');
      return;
    }

    try {
      await this.peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
      await this.processPendingPrivateIceCandidates();
    } catch (error) {
      console.error('[Calls] Error handling answer:', error);
      this.endCall();
    }
  }

  /**
   * Отправляет ICE candidate для приватных звонков
   */
  sendIceCandidate(candidate) {
    if (this.currentCall && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        type: 'call_ice_candidate',
        call_id: this.currentCall.call_id,
        candidate: candidate
      }));
    }
  }

  /**
   * Обрабатывает ICE candidate для приватных звонков.
   * Кандидаты, пришедшие до setRemoteDescription, ставим в очередь.
   */
  async handleIceCandidate(candidate, fromEmail = null) {
    if (!this.peerConnection) {
      return;
    }
    const c = candidate ? new RTCIceCandidate(candidate) : null;
    if (!this.peerConnection.remoteDescription) {
      if (c) this.pendingPrivateIceCandidates.push(c);
      return;
    }
    try {
      if (c) await this.peerConnection.addIceCandidate(c);
    } catch (error) {
      console.error('[Calls] Error adding ICE candidate:', error);
    }
  }

  /**
   * Добавляет отложенные ICE кандидаты после установки remote description (приватные звонки)
   */
  async processPendingPrivateIceCandidates() {
    if (!this.peerConnection?.remoteDescription || !this.pendingPrivateIceCandidates?.length) return;
    for (const c of this.pendingPrivateIceCandidates) {
      try {
        await this.peerConnection.addIceCandidate(c);
      } catch (e) {
        console.warn('[Calls] Error adding pending ICE candidate:', e);
      }
    }
    this.pendingPrivateIceCandidates = [];
  }

  /**
   * Создает и отправляет SDP offer (для инициатора приватного звонка)
   */
  async createAndSendOffer() {
    if (!this.peerConnection || this.currentCall?.role !== 'caller') {
      console.warn('[Calls] Cannot create offer: no peer connection or not caller');
      return;
    }

    try {
      // Убеждаемся, что локальные треки добавлены
      if (this.localStream) {
        const senders = this.peerConnection.getSenders();
        const hasAudioTrack = senders.some(sender => sender.track && sender.track.kind === 'audio');
        if (!hasAudioTrack) {
          console.log('[Calls] Adding local tracks to peer connection');
          this.localStream.getTracks().forEach(track => {
            if (track.readyState === 'live') {
              this.peerConnection.addTrack(track, this.localStream);
              console.log('[Calls] Added track:', track.kind, track.id);
            }
          });
        } else {
          console.log('[Calls] Local tracks already added');
        }
      } else {
        console.warn('[Calls] No local stream available');
      }

      // Ждем немного, чтобы треки успели добавиться
      await new Promise(resolve => setTimeout(resolve, 100));

      const offer = await this.peerConnection.createOffer();
      await this.peerConnection.setLocalDescription(offer);
      
      console.log('[Calls] Created and sending offer');
      this.ws.send(JSON.stringify({
        type: 'call_offer',
        call_id: this.currentCall.call_id,
        offer: offer
      }));
    } catch (error) {
      console.error('[Calls] Error creating offer:', error);
      this.endCall();
    }
  }

  /**
   * Переключает камеру/микрофон для приватных звонков
   */
  toggleMedia(mediaType) {
    if (!this.localStream) return;

    const tracks = mediaType === 'video' 
      ? this.localStream.getVideoTracks()
      : this.localStream.getAudioTracks();

    tracks.forEach(track => {
      track.enabled = !track.enabled;
    });
  }

  /**
   * Очищает ресурсы для приватных звонков
   */
  cleanup() {
    if (this.localStream) {
      this.localStream.getTracks().forEach(track => track.stop());
      this.localStream = null;
    }

    if (this.peerConnection) {
      this.peerConnection.close();
      this.peerConnection = null;
    }

    this.remoteStream = null;
    this.currentCall = null;
  }

  // ========================================================
  // === АУДИО-ЧАТЫ =========================================
  // ========================================================

  /**
   * Создает аудио-чат
   */
  async createAudioChat(chatId) {
    if (this.currentAudioChat) {
      console.warn('[AudioChat] Audio chat already exists');
      return false;
    }

    try {
      this.ws.send(JSON.stringify({
        type: 'create_audio_chat',
        chat_id: chatId
      }));

      return true;
    } catch (error) {
      console.error('[AudioChat] Error creating audio chat:', error);
      return false;
    }
  }

  /**
   * Присоединяется к аудио-чату
   */
  async joinAudioChat(audioRoomId) {
    if (!audioRoomId) {
      console.warn('[AudioChat] No audio_room_id provided');
      return;
    }

    try {
      // КРИТИЧЕСКИ ВАЖНО: Если мы уже были в этом чате и вышли,
      // очищаем старые соединения перед повторным присоединением
      if (this.currentAudioChat && this.currentAudioChat.audio_room_id === audioRoomId) {
        console.log('[AudioChat] Rejoining audio chat, cleaning up old connections');
        this.cleanupAudioChatConnections();
      }
      
      this.localStream = await navigator.mediaDevices.getUserMedia(
        this.getAudioConstraints(false)
      );
      console.log('[AudioChat] Got local stream with tracks:', this.localStream.getTracks().length);
      
      // КРИТИЧЕСКИ ВАЖНО: Убеждаемся, что все треки включены
      this.localStream.getTracks().forEach(track => {
        track.enabled = true;
        console.log(`[AudioChat] Local track initialized:`, {
          kind: track.kind,
          id: track.id,
          enabled: track.enabled,
          readyState: track.readyState
        });
        
        // Добавляем обработчик для завершения локального трека
        track.onended = () => {
          console.warn(`[AudioChat] Local track ${track.id} ended - attempting to recover...`);
          setTimeout(async () => {
            try {
              const newStream = await navigator.mediaDevices.getUserMedia(
                this.getAudioConstraints(false)
              );
              const newTrack = newStream.getAudioTracks()[0];
              if (newTrack) {
                // Заменяем трек во всех существующих соединениях
                this.audioChatPeerConnections.forEach((pc, email) => {
                  const senders = pc.getSenders();
                  const audioSender = senders.find(s => s.track && s.track.kind === 'audio');
                  if (audioSender) {
                    audioSender.replaceTrack(newTrack);
                    newTrack.enabled = true;
                    console.log(`[AudioChat] Replaced ended local track in connection with ${email}`);
                  }
                });
                
                // Обновляем localStream
                this.localStream.getTracks().forEach(oldTrack => oldTrack.stop());
                this.localStream = newStream;
                console.log(`[AudioChat] Recovered local stream`);
              }
            } catch (e) {
              console.error(`[AudioChat] Error recovering local track:`, e);
            }
          }, 100);
        };
      });

      // Отправляем запрос на присоединение
      this.ws.send(JSON.stringify({
        type: 'join_audio_chat',
        audio_room_id: audioRoomId
      }));

      // Обновляем состояние (создаем или обновляем)
      if (!this.currentAudioChat) {
        this.currentAudioChat = {
          audio_room_id: audioRoomId,
          participants: []
        };
      } else {
        // Обновляем audio_room_id на случай если что-то изменилось
        this.currentAudioChat.audio_room_id = audioRoomId;
      }

      // UI будет показан после получения audio_chat_joined
    } catch (error) {
      console.error('[AudioChat] Error joining audio chat:', error);
    }
  }

  /**
   * Выходит из аудио-чата
   */
  leaveAudioChat() {
    if (!this.currentAudioChat) {
      return;
    }

    const audioRoomId = this.currentAudioChat.audio_room_id;
    const chatId = this.currentAudioChat.chat_id;
    
    // КРИТИЧЕСКИ ВАЖНО: Очищаем соединения и UI, но НЕ удаляем информацию о чате
    // чтобы можно было зайти обратно без перезагрузки
    this.cleanupAudioChatConnections();
    this.hideAudioChatUI();
    
    // Отправляем запрос на выход
    this.ws.send(JSON.stringify({
      type: 'leave_audio_chat',
      audio_room_id: audioRoomId
    }));
    
    // КРИТИЧЕСКИ ВАЖНО: Сохраняем audio_room_id и chat_id для повторного присоединения
    // НЕ очищаем currentAudioChat полностью, только соединения
    // Это позволит зайти обратно без перезагрузки
    if (this.currentAudioChat) {
      // Убеждаемся, что audio_room_id и chat_id сохранены
      this.currentAudioChat.audio_room_id = audioRoomId;
      if (chatId) {
        this.currentAudioChat.chat_id = chatId;
      }
    }
  }

  /**
   * Обрабатывает присоединение к аудио-чату
   */
  async handleAudioChatJoined(data) {
    // КРИТИЧЕСКИ ВАЖНО: Сохраняем chat_id для правильной работы кнопки "присоединиться"
    if (!this.currentAudioChat) {
      this.currentAudioChat = {
        audio_room_id: data.audio_room_id,
        chat_id: data.chat_id,
        participants: data.participants || []
      };
    } else {
      this.currentAudioChat.participants = data.participants || [];
      // Обновляем chat_id если он изменился
      if (data.chat_id) {
        this.currentAudioChat.chat_id = data.chat_id;
      }
      // Обновляем audio_room_id на случай если что-то изменилось
      this.currentAudioChat.audio_room_id = data.audio_room_id;
    }

    // Убеждаемся, что у нас есть локальный поток
    if (!this.localStream) {
      try {
        this.localStream = await navigator.mediaDevices.getUserMedia(
          this.getAudioConstraints(false)
        );
      } catch (error) {
        console.error('[AudioChat] Error getting local stream:', error);
        return;
      }
    }

    // Создаем соединения с уже присоединившимися участниками
    const currentUserEmailLower = this.currentUserEmail.toLowerCase();
    const joinedParticipants = data.participants || [];
    
    console.log(`[AudioChat] Creating connections with ${joinedParticipants.length} participants`);
    console.log(`[AudioChat] Participants:`, joinedParticipants);
    console.log(`[AudioChat] Current user:`, currentUserEmailLower);
    console.log(`[AudioChat] Local stream:`, this.localStream ? `${this.localStream.getTracks().length} tracks` : 'none');
    
    // Убеждаемся, что локальный поток готов
    if (!this.localStream) {
      console.error('[AudioChat] No local stream when joining audio chat');
      return;
    }
    
    const localTracks = this.localStream.getTracks();
    console.log(`[AudioChat] Local tracks:`, localTracks.map(t => ({
      kind: t.kind,
      id: t.id,
      enabled: t.enabled,
      readyState: t.readyState
    })));
    
    // Создаем соединения со всеми участниками (кроме себя)
    // ВАЖНО: Каждый участник создает соединение с каждым другим участником
    const connectionPromises = [];
    const normalizedParticipants = joinedParticipants.map(p => p.toLowerCase());
    
    normalizedParticipants.forEach(participantEmailLower => {
      if (participantEmailLower !== currentUserEmailLower) {
        // КРИТИЧЕСКИ ВАЖНО: При повторном присоединении закрываем старое соединение и создаем новое
        const existingPc = this.audioChatPeerConnections.get(participantEmailLower);
        if (existingPc) {
          console.log(`[AudioChat] Closing existing connection with ${participantEmailLower} before reconnecting`);
          try {
            existingPc.close();
          } catch (error) {
            console.error(`[AudioChat] Error closing existing connection:`, error);
          }
          this.audioChatPeerConnections.delete(participantEmailLower);
          
          // Останавливаем старый remote stream
          const oldStream = this.audioChatRemoteStreams.get(participantEmailLower);
          if (oldStream) {
            oldStream.getTracks().forEach(track => {
              try {
                track.stop();
              } catch (error) {
                console.error(`[AudioChat] Error stopping old track:`, error);
              }
            });
            this.audioChatRemoteStreams.delete(participantEmailLower);
          }
        }
        
        console.log(`[AudioChat] Creating connection with ${participantEmailLower}`);
        connectionPromises.push(
          this.createAndSendOfferForParticipant(participantEmailLower)
            .then(() => {
              console.log(`[AudioChat] Successfully created offer for ${participantEmailLower}`);
            })
            .catch(error => {
              console.error(`[AudioChat] Error creating connection with ${participantEmailLower}:`, error);
            })
        );
      } else {
        console.log(`[AudioChat] Skipping self: ${participantEmailLower}`);
      }
    });
    
    // Ждем создания всех соединений (не блокируем, если некоторые не удались)
    try {
      await Promise.allSettled(connectionPromises);
      console.log(`[AudioChat] All connection offers processed`);
      
      // Проверяем, сколько соединений создано
      console.log(`[AudioChat] Total peer connections:`, this.audioChatPeerConnections.size);
      this.audioChatPeerConnections.forEach((pc, email) => {
        console.log(`[AudioChat] Connection with ${email}:`, {
          connectionState: pc.connectionState,
          iceConnectionState: pc.iceConnectionState
        });
      });
    } catch (error) {
      console.error('[AudioChat] Error creating connections:', error);
    }

    // Показываем модалку аудио-чата
    this.showAudioChatUI();
  }

  /**
   * Обрабатывает присоединение участника к аудио-чату
   */
  async handleParticipantJoined(participantEmail, participants) {
    if (!this.currentAudioChat) {
      console.warn('[AudioChat] No current audio chat when participant joined');
      return;
    }

    const participantEmailLower = participantEmail.toLowerCase();
    const currentUserEmailLower = this.currentUserEmail.toLowerCase();
    
    // Обновляем список участников
    this.currentAudioChat.participants = participants || [];
    
    console.log(`[AudioChat] ===== PARTICIPANT JOINED =====`);
    console.log(`[AudioChat] New participant: ${participantEmailLower}`);
    console.log(`[AudioChat] Current user: ${currentUserEmailLower}`);
    console.log(`[AudioChat] All participants:`, this.currentAudioChat.participants);

    // Пропускаем себя
    if (participantEmailLower === currentUserEmailLower) {
      console.log(`[AudioChat] Skipping self: ${participantEmailLower}`);
      return;
    }

    // Проверяем, не создали ли мы уже соединение с этим участником
    if (this.audioChatPeerConnections.has(participantEmailLower)) {
      console.log(`[AudioChat] Connection with ${participantEmailLower} already exists, checking state...`);
      const existingPc = this.audioChatPeerConnections.get(participantEmailLower);
      console.log(`[AudioChat] Existing connection state:`, {
        connectionState: existingPc.connectionState,
        iceConnectionState: existingPc.iceConnectionState,
        signalingState: existingPc.signalingState
      });
      
      // Если соединение не установлено, создаем новое
      if (existingPc.connectionState === 'closed' || existingPc.connectionState === 'failed') {
        console.log(`[AudioChat] Existing connection is ${existingPc.connectionState}, creating new one...`);
        existingPc.close();
        this.audioChatPeerConnections.delete(participantEmailLower);
        this.audioChatRemoteStreams.delete(participantEmailLower);
      } else {
        console.log(`[AudioChat] Connection with ${participantEmailLower} is active, skipping`);
        return;
      }
    }

    // КРИТИЧЕСКИ ВАЖНО: Убеждаемся, что у нас есть локальный поток
    if (!this.localStream) {
      console.log(`[AudioChat] Getting local stream for new participant ${participantEmailLower}`);
      try {
        this.localStream = await navigator.mediaDevices.getUserMedia(
          this.getAudioConstraints(false)
        );
        console.log(`[AudioChat] Got local stream with ${this.localStream.getTracks().length} tracks`);
        
        // Убеждаемся, что треки включены
        this.localStream.getTracks().forEach(track => {
          track.enabled = true;
          // Примечание: track.muted - это только геттер, его нельзя установить
          console.log(`[AudioChat] Local track:`, {
            kind: track.kind,
            id: track.id,
            enabled: track.enabled,
            readyState: track.readyState
          });
        });
      } catch (error) {
        console.error('[AudioChat] Error getting local stream for new participant:', error);
        return;
      }
    }
    
    // КРИТИЧЕСКИ ВАЖНО: Создаем соединение и отправляем offer
    console.log(`[AudioChat] Creating connection with new participant ${participantEmailLower}`);
    try {
      await this.createAndSendOfferForParticipant(participantEmailLower);
      console.log(`[AudioChat] ✅ Successfully created and sent offer for ${participantEmailLower}`);
    } catch (error) {
      console.error(`[AudioChat] ❌ Error creating connection with ${participantEmailLower}:`, error);
    }
  }

  /**
   * Обрабатывает выход участника из аудио-чата
   */
  handleParticipantLeft(participantEmail) {
    const participantEmailLower = participantEmail.toLowerCase();
    console.log(`[AudioChat] Participant ${participantEmailLower} left`);
    
    // Закрываем соединение с участником
    const pc = this.audioChatPeerConnections.get(participantEmailLower);
    if (pc) {
      console.log(`[AudioChat] Closing peer connection with ${participantEmailLower}`);
      try {
        pc.close();
      } catch (error) {
        console.error(`[AudioChat] Error closing peer connection:`, error);
      }
      this.audioChatPeerConnections.delete(participantEmailLower);
    }
    
    // Удаляем remote stream
    const stream = this.audioChatRemoteStreams.get(participantEmailLower);
    if (stream) {
      console.log(`[AudioChat] Stopping remote stream from ${participantEmailLower}`);
      stream.getTracks().forEach(track => {
        try {
          track.stop();
        } catch (error) {
          console.error(`[AudioChat] Error stopping track:`, error);
        }
      });
      this.audioChatRemoteStreams.delete(participantEmailLower);
    }
    
    // Удаляем из списка участников
    if (this.currentAudioChat && this.currentAudioChat.participants) {
      this.currentAudioChat.participants = this.currentAudioChat.participants.filter(
        p => p.toLowerCase() !== participantEmailLower
      );
    }
    
    // Обновляем список участников
    if (this.currentAudioChat) {
      this.currentAudioChat.participants = this.currentAudioChat.participants.filter(
        p => p.toLowerCase() !== participantEmailLower
      );
      console.log(`[AudioChat] Updated participants list:`, this.currentAudioChat.participants);
    }
  }

  /**
   * Создает peer connection для участника аудио-чата
   */
  async createPeerConnectionForParticipant(participantEmail) {
    const participantEmailLower = participantEmail.toLowerCase();
    
    if (this.audioChatPeerConnections.has(participantEmailLower)) {
      const existingPc = this.audioChatPeerConnections.get(participantEmailLower);
      console.log(`[AudioChat] Reusing existing peer connection for ${participantEmailLower}`);
      
      // Убеждаемся, что локальные треки добавлены
      if (this.localStream) {
        const senders = existingPc.getSenders();
        const hasAudioTrack = senders.some(sender => sender.track && sender.track.kind === 'audio');
        
        if (!hasAudioTrack) {
          console.log(`[AudioChat] Adding local tracks to existing connection for ${participantEmailLower}`);
          this.localStream.getTracks().forEach(track => {
            if (track.readyState === 'live') {
              try {
                existingPc.addTrack(track, this.localStream);
                track.enabled = true;
                // Примечание: track.muted - это только геттер, его нельзя установить
              } catch (e) {
                console.error(`[AudioChat] Error adding track to existing connection:`, e);
              }
            }
          });
        }
      }
      return existingPc;
    }

    const iceServers = await this.getIceServers();
    const pc = new RTCPeerConnection({
      iceServers,
      iceCandidatePoolSize: 10,
      bundlePolicy: 'max-bundle',
      rtcpMuxPolicy: 'require',
    });

    // Добавляем локальные треки
    if (this.localStream) {
      const tracks = this.localStream.getTracks();
      console.log(`[AudioChat] Adding ${tracks.length} local tracks to peer connection for ${participantEmail}`);
      
      // КРИТИЧЕСКИ ВАЖНО: Убеждаемся, что все треки включены перед добавлением
      tracks.forEach(track => {
        track.enabled = true;
      });
      
      tracks.forEach(track => {
        // Проверяем, что трек активен
        if (track.readyState === 'live') {
          try {
            const sender = pc.addTrack(track, this.localStream);
            // Убеждаемся, что трек включен
            track.enabled = true;
            // Примечание: track.muted - это только геттер, его нельзя установить
            
            // КРИТИЧЕСКИ ВАЖНО: Добавляем обработчики для отслеживания состояния локального трека
            track.onended = () => {
              console.warn(`[AudioChat] Local track ${track.id} ended for ${participantEmailLower} - attempting to recover...`);
              // Пытаемся получить новый трек из localStream
              setTimeout(() => {
                const newTracks = this.localStream ? this.localStream.getTracks() : [];
                const newAudioTrack = newTracks.find(t => t.kind === 'audio' && t.readyState === 'live');
                if (newAudioTrack && pc) {
                  try {
                    const senders = pc.getSenders();
                    const audioSender = senders.find(s => s.track && s.track.kind === 'audio');
                    if (audioSender) {
                      audioSender.replaceTrack(newAudioTrack);
                      newAudioTrack.enabled = true;
                      console.log(`[AudioChat] Replaced ended local track with new track for ${participantEmailLower}`);
                    } else {
                      pc.addTrack(newAudioTrack, this.localStream);
                      newAudioTrack.enabled = true;
                      console.log(`[AudioChat] Added new local track after old one ended for ${participantEmailLower}`);
                    }
                  } catch (e) {
                    console.error(`[AudioChat] Error recovering local track:`, e);
                  }
                }
              }, 100);
            };
            
            console.log(`[AudioChat] Added local track:`, {
              kind: track.kind,
              id: track.id,
              enabled: track.enabled,
              muted: track.muted,
              readyState: track.readyState,
              sender: !!sender
            });
          } catch (e) {
            console.error(`[AudioChat] Error adding track to ${participantEmail}:`, e);
          }
        } else {
          console.warn(`[AudioChat] Track ${track.id} is not live, state:`, track.readyState);
        }
      });
      
      // Проверяем, что треки действительно добавлены
      const senders = pc.getSenders();
      console.log(`[AudioChat] Total senders after adding tracks:`, senders.length);
      
      if (senders.length === 0) {
        console.error(`[AudioChat] ❌ No senders after adding tracks! This is a problem.`);
      } else {
        senders.forEach((sender, index) => {
          console.log(`[AudioChat] Sender ${index}:`, {
            track: sender.track?.kind,
            trackId: sender.track?.id,
            trackEnabled: sender.track?.enabled
          });
        });
      }
    } else {
      console.error(`[AudioChat] ❌ No local stream when creating peer connection for ${participantEmail}`);
    }

    // Обработчики
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        console.log(`[AudioChat] ICE candidate from ${participantEmailLower}:`, event.candidate.candidate.substring(0, 50) + '...');
        this.sendIceCandidateToParticipant(event.candidate, participantEmailLower);
      } else {
        console.log(`[AudioChat] ICE candidate gathering complete for ${participantEmailLower}`);
      }
    };

    // КРИТИЧЕСКИ ВАЖНО: Обработчик для получения remote tracks
    pc.ontrack = (event) => {
      const participantEmailLower = participantEmail.toLowerCase();
      console.log(`[AudioChat] ===== ONTRACK EVENT from ${participantEmailLower} =====`);
      console.log(`[AudioChat] Event details:`, {
        kind: event.track?.kind,
        id: event.track?.id,
        enabled: event.track?.enabled,
        muted: event.track?.muted,
        readyState: event.track?.readyState,
        streams: event.streams?.length,
        track: !!event.track,
        transceiver: !!event.transceiver
      });
      
      // КРИТИЧЕСКИ ВАЖНО: Проверяем наличие трека
      if (!event.track) {
        console.error(`[AudioChat] ❌ No track in event from ${participantEmailLower}`);
        return;
      }
      
      // КРИТИЧЕСКИ ВАЖНО: Включаем трек сразу
      event.track.enabled = true;
      // Примечание: track.muted - это только геттер, его нельзя установить
      
      // Устанавливаем обработчики для трека
      event.track.onended = () => {
        console.warn(`[AudioChat] Track ${event.track.id} from ${participantEmailLower} ended - attempting to recover...`);
        // КРИТИЧЕСКИ ВАЖНО: Когда трек завершается, пытаемся получить новый из receivers
        setTimeout(() => {
          this.recoverStreamFromReceivers(participantEmailLower);
        }, 100);
      };
      
      event.track.onmute = () => {
        console.warn(`[AudioChat] Track ${event.track.id} from ${participantEmailLower} muted - RE-ENABLING`);
        setTimeout(() => {
          event.track.enabled = true;
          // Примечание: track.muted - это только геттер, его нельзя установить
        }, 100);
      };
      
      event.track.onunmute = () => {
        console.log(`[AudioChat] Track ${event.track.id} from ${participantEmailLower} unmuted`);
      };
      
      let stream = null;
      
      // Приоритет: используем поток из события, если есть
      if (event.streams && event.streams.length > 0) {
        stream = event.streams[0];
        console.log(`[AudioChat] Using stream from event.streams[0], tracks: ${stream.getTracks().length}`);
      } else if (event.track) {
        // Если потока нет, создаем новый поток из трека
        stream = new MediaStream([event.track]);
        console.log(`[AudioChat] Created new MediaStream from track`);
      }
      
      if (!stream) {
        console.error(`[AudioChat] No stream available from ${participantEmailLower}`);
        return;
      }
      
      // Убеждаемся, что трек добавлен в поток
      if (event.track && !stream.getTracks().includes(event.track)) {
        stream.addTrack(event.track);
        console.log(`[AudioChat] Added track to stream`);
      }
      
      if (stream.getTracks().length === 0) {
        console.error(`[AudioChat] Stream from ${participantEmailLower} has no tracks`);
        return;
      }
      
      // КРИТИЧЕСКИ ВАЖНО: Убеждаемся, что все треки включены и активны
      stream.getTracks().forEach(track => {
        // Включаем трек
        track.enabled = true;
        // Примечание: track.muted - это только геттер, его нельзя установить
        
        // Обработчики для отслеживания состояния трека
        track.onended = () => {
          console.warn(`[AudioChat] Track ${track.id} from ${participantEmailLower} ended - attempting to recover...`);
          // КРИТИЧЕСКИ ВАЖНО: Когда трек завершается, пытаемся получить новый из receivers
          setTimeout(() => {
            this.recoverStreamFromReceivers(participantEmailLower);
          }, 100);
        };
        
        track.onmute = () => {
          console.warn(`[AudioChat] Track ${track.id} from ${participantEmailLower} muted - RE-ENABLING`);
          // Автоматически включаем обратно
          setTimeout(() => {
            track.enabled = true;
            // Примечание: track.muted - это только геттер, его нельзя установить
          }, 100);
        };
        
        track.onunmute = () => {
          console.log(`[AudioChat] Track ${track.id} from ${participantEmailLower} unmuted`);
        };
        
        // Устанавливаем настройки качества для аудио треков
        if (track.kind === 'audio' && track.getSettings) {
          try {
            const settings = track.getSettings();
            console.log(`[AudioChat] Audio track settings for ${participantEmailLower}:`, settings);
          } catch (e) {
            console.warn(`[AudioChat] Could not get track settings:`, e);
          }
        }
        
        console.log(`[AudioChat] Track from ${participantEmailLower}:`, {
          kind: track.kind,
          id: track.id,
          enabled: track.enabled,
          readyState: track.readyState,
          muted: track.muted
        });
      });
      
      console.log(`[AudioChat] Stream has ${stream.getTracks().length} tracks`);
      
      // Сохраняем или обновляем поток
      const existingStream = this.audioChatRemoteStreams.get(participantEmailLower);
      if (existingStream) {
        // Проверяем, не является ли новый поток тем же самым
        const existingTracks = existingStream.getTracks();
        const newTracks = stream.getTracks();
        const hasNewTracks = newTracks.some(newTrack => 
          !existingTracks.some(existingTrack => existingTrack.id === newTrack.id)
        );
        
        if (hasNewTracks) {
          // Добавляем новые треки в существующий поток
          newTracks.forEach(track => {
            if (!existingTracks.some(et => et.id === track.id)) {
              existingStream.addTrack(track);
              track.enabled = true;
              // Примечание: track.muted - это только геттер, его нельзя установить
              console.log(`[AudioChat] Added new track to existing stream for ${participantEmailLower}`);
            }
          });
          // Используем обновленный существующий поток
          stream = existingStream;
        } else {
          // Останавливаем старые треки, которые больше не нужны
          existingTracks.forEach(track => {
            if (!newTracks.some(nt => nt.id === track.id)) {
              track.stop();
            }
          });
        }
      }
      
      this.audioChatRemoteStreams.set(participantEmailLower, stream);
      
      // КРИТИЧЕСКИ ВАЖНО: Убеждаемся, что все треки включены перед вызовом обработчика
      stream.getTracks().forEach(track => {
        track.enabled = true;
        // Примечание: track.muted - это только геттер, его нельзя установить
        console.log(`[AudioChat] Final track check before calling handler:`, {
          id: track.id,
          kind: track.kind,
          enabled: track.enabled,
          muted: track.muted,
          readyState: track.readyState
        });
      });
      
      // КРИТИЧЕСКИ ВАЖНО: Проверяем, что поток активен
      if (!stream.active) {
        console.warn(`[AudioChat] Stream from ${participantEmailLower} is not active, waiting...`);
        // Ждем активации потока
        const checkActive = setInterval(() => {
          if (stream.active) {
            clearInterval(checkActive);
            console.log(`[AudioChat] Stream from ${participantEmailLower} is now active`);
            this.onAudioChatRemoteStreamReceived(stream, participantEmailLower);
          }
        }, 100);
        
        // Таймаут на случай, если поток не активируется
        setTimeout(() => {
          clearInterval(checkActive);
          if (!stream.active) {
            console.warn(`[AudioChat] Stream from ${participantEmailLower} still not active, calling handler anyway`);
          }
          this.onAudioChatRemoteStreamReceived(stream, participantEmailLower);
        }, 2000);
      } else {
        console.log(`[AudioChat] ✅✅✅ Calling onAudioChatRemoteStreamReceived for ${participantEmailLower} ✅✅✅`);
        console.log(`[AudioChat] Stream details:`, {
          id: stream.id,
          active: stream.active,
          tracks: stream.getTracks().length,
          audioTracks: stream.getAudioTracks().length
        });
        
        // Вызываем обработчик немедленно
        this.onAudioChatRemoteStreamReceived(stream, participantEmailLower);
      }
    };

    pc.onconnectionstatechange = () => {
      console.log(`[AudioChat] Connection state with ${participantEmail}:`, {
        connectionState: pc.connectionState,
        iceConnectionState: pc.iceConnectionState,
        iceGatheringState: pc.iceGatheringState,
        signalingState: pc.signalingState
      });
      
      if (pc.connectionState === 'connected') {
        console.log(`[AudioChat] ✅✅✅ Successfully CONNECTED to ${participantEmailLower} ✅✅✅`);
        // Проверяем, что у нас есть локальные треки
        const senders = pc.getSenders();
        console.log(`[AudioChat] Senders when connected:`, senders.length);
        senders.forEach(sender => {
          if (sender.track) {
            console.log(`[AudioChat] Sender track:`, {
              kind: sender.track.kind,
              enabled: sender.track.enabled,
              readyState: sender.track.readyState
            });
            // Убеждаемся, что трек включен
            sender.track.enabled = true;
            // Примечание: track.muted - это только геттер, его нельзя установить
            
            // КРИТИЧЕСКИ ВАЖНО: Добавляем обработчик для завершения локального трека
            sender.track.onended = () => {
              console.warn(`[AudioChat] Sender track ${sender.track.id} ended for ${participantEmailLower} - attempting to recover...`);
              setTimeout(() => {
                if (this.localStream) {
                  const newTracks = this.localStream.getTracks();
                  const newAudioTrack = newTracks.find(t => t.kind === 'audio' && t.readyState === 'live');
                  if (newAudioTrack) {
                    try {
                      sender.replaceTrack(newAudioTrack);
                      newAudioTrack.enabled = true;
                      console.log(`[AudioChat] Replaced ended sender track with new track for ${participantEmailLower}`);
                    } catch (e) {
                      console.error(`[AudioChat] Error replacing sender track:`, e);
                    }
                  }
                }
              }, 100);
            };
          }
        });
        
        // КРИТИЧЕСКИ ВАЖНО: Устанавливаем периодическую проверку соединения для удаленных звонков
        const connectionCheckInterval = setInterval(() => {
          if (pc.connectionState === 'closed' || pc.connectionState === 'failed') {
            clearInterval(connectionCheckInterval);
            return;
          }
          
          // Проверяем локальные треки
          const currentSenders = pc.getSenders();
          const endedSenders = currentSenders.filter(s => s.track && s.track.readyState === 'ended');
          if (endedSenders.length > 0 && this.localStream) {
            console.warn(`[AudioChat] Some sender tracks ended for ${participantEmailLower}, attempting to recover...`);
            const newTracks = this.localStream.getTracks();
            const newAudioTrack = newTracks.find(t => t.kind === 'audio' && t.readyState === 'live');
            if (newAudioTrack) {
              endedSenders.forEach(sender => {
                try {
                  sender.replaceTrack(newAudioTrack);
                  newAudioTrack.enabled = true;
                  console.log(`[AudioChat] Recovered sender track for ${participantEmailLower}`);
                } catch (e) {
                  console.error(`[AudioChat] Error recovering sender track:`, e);
                }
              });
            }
          }
          
          // Проверяем удаленные треки
          const receivers = pc.getReceivers();
          const endedReceivers = receivers.filter(r => r.track && r.track.readyState === 'ended');
          if (endedReceivers.length > 0) {
            console.warn(`[AudioChat] Some receiver tracks ended for ${participantEmailLower}, attempting to recover...`);
            this.recoverStreamFromReceivers(participantEmailLower);
          }
        }, 3000); // Проверяем каждые 3 секунды
        
        // КРИТИЧЕСКИ ВАЖНО: Проверяем remote tracks и создаем потоки
        const receivers = pc.getReceivers();
        console.log(`[AudioChat] Receivers when connected:`, receivers.length);
        receivers.forEach(receiver => {
          if (receiver.track) {
            console.log(`[AudioChat] Receiver track:`, {
              kind: receiver.track.kind,
              enabled: receiver.track.enabled,
              readyState: receiver.track.readyState
            });
            // Убеждаемся, что remote трек включен
            receiver.track.enabled = true;
            // Примечание: track.muted - это только геттер, его нельзя установить
            
            // КРИТИЧЕСКИ ВАЖНО: Добавляем обработчик для завершения трека
            receiver.track.onended = () => {
              console.warn(`[AudioChat] Receiver track ${receiver.track.id} from ${participantEmailLower} ended - attempting to recover...`);
              setTimeout(() => {
                this.recoverStreamFromReceivers(participantEmailLower);
              }, 100);
            };
            
            // КРИТИЧЕСКИ ВАЖНО: Если потока еще нет, создаем его из receiver track
            if (!this.audioChatRemoteStreams.has(participantEmailLower)) {
              const stream = new MediaStream([receiver.track]);
              // Убеждаемся, что трек включен
              receiver.track.enabled = true;
              // Примечание: track.muted - это только геттер, его нельзя установить
              this.audioChatRemoteStreams.set(participantEmailLower, stream);
              console.log(`[AudioChat] Created stream from receiver track for ${participantEmailLower}`);
              // Вызываем обработчик немедленно
              this.onAudioChatRemoteStreamReceived(stream, participantEmailLower);
            } else {
              // Если поток уже есть, добавляем трек в него
              const existingStream = this.audioChatRemoteStreams.get(participantEmailLower);
              if (existingStream && !existingStream.getTracks().includes(receiver.track)) {
                existingStream.addTrack(receiver.track);
                receiver.track.enabled = true;
                // Примечание: track.muted - это только геттер, его нельзя установить
                console.log(`[AudioChat] Added receiver track to existing stream for ${participantEmailLower}`);
                // Обновляем audio элемент
                setTimeout(() => {
                  this.onAudioChatRemoteStreamReceived(existingStream, participantEmailLower);
                }, 100);
              }
            }
          }
        });
      }
      
      if (pc.connectionState === 'failed') {
        console.warn(`[AudioChat] Connection failed with ${participantEmailLower}, attempting to reconnect...`);
        // Не удаляем сразу, пытаемся переподключиться
        
        // Удаляем старое соединение
        this.audioChatPeerConnections.delete(participantEmailLower);
        
        // Пытаемся переподключиться через небольшую задержку
        setTimeout(async () => {
          if (this.currentAudioChat && this.localStream) {
            console.log(`[AudioChat] Attempting to reconnect to ${participantEmailLower}`);
            try {
              await this.createAndSendOfferForParticipant(participantEmailLower);
            } catch (error) {
              console.error(`[AudioChat] Error reconnecting to ${participantEmailLower}:`, error);
            }
          }
        }, 2000);
      } else if (pc.connectionState === 'disconnected') {
        console.warn(`[AudioChat] Connection disconnected with ${participantEmailLower}`);
        // Не удаляем при disconnected, может быть временное отключение
        // Соединение может восстановиться автоматически
      }
    };
    
    // Отслеживаем изменения ICE соединения
    pc.oniceconnectionstatechange = () => {
      console.log(`[AudioChat] ICE connection state with ${participantEmailLower}:`, pc.iceConnectionState);
      if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
        console.log(`[AudioChat] ✅✅✅ ICE connection ESTABLISHED with ${participantEmailLower} ✅✅✅`);
        
        // Проверяем remote tracks при установлении ICE соединения
        const receivers = pc.getReceivers();
        console.log(`[AudioChat] Receivers when ICE connected:`, receivers.length);
        receivers.forEach(receiver => {
          if (receiver.track) {
            console.log(`[AudioChat] Receiver track when ICE connected:`, {
              kind: receiver.track.kind,
              enabled: receiver.track.enabled,
              readyState: receiver.track.readyState
            });
            receiver.track.enabled = true;
            
            // КРИТИЧЕСКИ ВАЖНО: Добавляем обработчик для завершения трека
            receiver.track.onended = () => {
              console.warn(`[AudioChat] Receiver track ${receiver.track.id} from ${participantEmailLower} ended - attempting to recover...`);
              setTimeout(() => {
                this.recoverStreamFromReceivers(participantEmailLower);
              }, 100);
            };
            // Примечание: track.muted - это только геттер, его нельзя установить
            
            // Если трек еще не в потоке, создаем поток и вызываем обработчик
            if (!this.audioChatRemoteStreams.has(participantEmailLower)) {
              const stream = new MediaStream([receiver.track]);
              // Убеждаемся, что трек включен
              receiver.track.enabled = true;
              // Примечание: track.muted - это только геттер, его нельзя установить
              this.audioChatRemoteStreams.set(participantEmailLower, stream);
              console.log(`[AudioChat] Created stream from receiver track for ${participantEmailLower}`);
              // Вызываем обработчик немедленно
              this.onAudioChatRemoteStreamReceived(stream, participantEmailLower);
            } else {
              // Если поток уже есть, добавляем трек в него
              const existingStream = this.audioChatRemoteStreams.get(participantEmailLower);
              if (existingStream && !existingStream.getTracks().includes(receiver.track)) {
                existingStream.addTrack(receiver.track);
                receiver.track.enabled = true;
                // Примечание: track.muted - это только геттер, его нельзя установить
                console.log(`[AudioChat] Added receiver track to existing stream for ${participantEmailLower}`);
                // Обновляем audio элемент
                setTimeout(() => {
                  this.onAudioChatRemoteStreamReceived(existingStream, participantEmailLower);
                }, 100);
              }
            }
          }
        });
      } else if (pc.iceConnectionState === 'failed') {
        console.error(`[AudioChat] ❌ ICE connection FAILED with ${participantEmailLower}, attempting to restart ICE...`);
        
        // Пытаемся перезапустить ICE (используем async функцию)
        (async () => {
          try {
            const offer = await pc.createOffer({ iceRestart: true });
            await pc.setLocalDescription(offer);
            
            // Отправляем новый offer
            this.ws.send(JSON.stringify({
              type: 'audio_chat_offer',
              audio_room_id: this.currentAudioChat.audio_room_id,
              offer: offer,
              target_email: participantEmailLower
            }));
            
            console.log(`[AudioChat] Sent ICE restart offer to ${participantEmailLower}`);
          } catch (error) {
            console.error(`[AudioChat] Error restarting ICE for ${participantEmailLower}:`, error);
            
            // Если перезапуск ICE не помог, пытаемся переподключиться
            setTimeout(async () => {
              if (this.currentAudioChat && this.localStream) {
                console.log(`[AudioChat] Attempting to reconnect after ICE failure to ${participantEmailLower}`);
                try {
                  // Удаляем старое соединение
                  this.audioChatPeerConnections.delete(participantEmailLower);
                  this.audioChatRemoteStreams.delete(participantEmailLower);
                  
                  // Создаем новое соединение
                  await this.createAndSendOfferForParticipant(participantEmailLower);
                } catch (reconnectError) {
                  console.error(`[AudioChat] Error reconnecting after ICE failure:`, reconnectError);
                }
              }
            }, 3000);
          }
        })();
      }
    };

    this.audioChatPeerConnections.set(participantEmailLower, pc);
    console.log(`[AudioChat] Created new peer connection for ${participantEmailLower}`);
    return pc;
  }

  /**
   * Создает и отправляет SDP offer для участника аудио-чата
   */
  async createAndSendOfferForParticipant(participantEmail) {
    const participantEmailLower = participantEmail.toLowerCase();
    console.log(`[AudioChat] Creating and sending offer to ${participantEmailLower}`);
    
    // КРИТИЧЕСКИ ВАЖНО: Убеждаемся, что у нас есть локальный поток
    if (!this.localStream) {
      console.error(`[AudioChat] No local stream available for ${participantEmailLower}`);
      return;
    }
    
    const pc = await this.createPeerConnectionForParticipant(participantEmailLower);
    
    try {
      const senders = pc.getSenders();
      const hasAudioTrack = senders.some(sender => sender.track && sender.track.kind === 'audio');
      
      if (!hasAudioTrack) {
        console.log(`[AudioChat] Adding local tracks to peer connection for ${participantEmailLower}`);
        this.localStream.getTracks().forEach(track => {
          if (track.readyState === 'live') {
            try {
              const sender = pc.addTrack(track, this.localStream);
              console.log(`[AudioChat] Added track:`, {
                kind: track.kind,
                id: track.id,
                enabled: track.enabled,
                sender: !!sender
              });
              
              // Убеждаемся, что трек включен
              track.enabled = true;
              // Примечание: track.muted - это только геттер, его нельзя установить
            } catch (e) {
              console.error(`[AudioChat] Error adding track:`, e);
            }
          } else {
            console.warn(`[AudioChat] Track ${track.id} is not live, state:`, track.readyState);
          }
        });
        
        // Проверяем, что треки действительно добавлены
        const newSenders = pc.getSenders();
        console.log(`[AudioChat] Senders after adding tracks:`, newSenders.length);
        newSenders.forEach(sender => {
          console.log(`[AudioChat] Sender track:`, {
            kind: sender.track?.kind,
            id: sender.track?.id,
            enabled: sender.track?.enabled,
            readyState: sender.track?.readyState
          });
        });
      } else {
        console.log(`[AudioChat] Local tracks already added for ${participantEmailLower}`);
        // Убеждаемся, что существующие треки включены
        senders.forEach(sender => {
          if (sender.track) {
            sender.track.enabled = true;
            // Примечание: track.muted - это только геттер, его нельзя установить
          }
        });
      }

      // Ждем, чтобы треки точно добавились
      await new Promise(resolve => setTimeout(resolve, 300));

      // КРИТИЧЕСКИ ВАЖНО: Проверяем еще раз перед созданием offer
      const finalSenders = pc.getSenders();
      const hasAudio = finalSenders.some(sender => sender.track && sender.track.kind === 'audio');
      
      if (!hasAudio) {
        console.error(`[AudioChat] ❌ No audio track in senders before creating offer for ${participantEmailLower}`);
        console.error(`[AudioChat] Senders count: ${finalSenders.length}`);
        finalSenders.forEach((sender, index) => {
          console.error(`[AudioChat] Sender ${index}:`, {
            track: sender.track?.kind,
            trackId: sender.track?.id,
            trackEnabled: sender.track?.enabled
          });
        });
        
        // КРИТИЧЕСКИ ВАЖНО: Пытаемся добавить еще раз с использованием replaceTrack
        const audioTracks = this.localStream.getAudioTracks();
        console.log(`[AudioChat] Local audio tracks: ${audioTracks.length}`);
        
        if (audioTracks.length > 0) {
          // Пробуем использовать replaceTrack если есть senders
          if (finalSenders.length > 0) {
            const audioSender = finalSenders.find(s => s.track === null || s.track.kind !== 'audio');
            if (audioSender && audioTracks[0]) {
              try {
                await audioSender.replaceTrack(audioTracks[0]);
                console.log(`[AudioChat] Replaced track using replaceTrack`);
              } catch (e) {
                console.error(`[AudioChat] Error replacing track:`, e);
                // Если replaceTrack не работает, добавляем новый трек
                try {
                  pc.addTrack(audioTracks[0], this.localStream);
                  audioTracks[0].enabled = true;
                  // Примечание: track.muted - это только геттер, его нельзя установить
                  console.log(`[AudioChat] Added track after replaceTrack failed`);
                } catch (e2) {
                  console.error(`[AudioChat] Error adding track after replaceTrack:`, e2);
                }
              }
            } else {
              // Если нет подходящего sender, добавляем новый трек
              try {
                pc.addTrack(audioTracks[0], this.localStream);
                audioTracks[0].enabled = true;
                // Примечание: track.muted - это только геттер, его нельзя установить
                console.log(`[AudioChat] Added track (no suitable sender)`);
              } catch (e) {
                console.error(`[AudioChat] Error adding track:`, e);
              }
            }
          } else {
            // Если нет senders вообще, добавляем трек
            try {
              pc.addTrack(audioTracks[0], this.localStream);
              audioTracks[0].enabled = true;
              // Примечание: track.muted - это только геттер, его нельзя установить
              console.log(`[AudioChat] Added track (no senders)`);
            } catch (e) {
              console.error(`[AudioChat] Error adding track:`, e);
            }
          }
        }
        
        await new Promise(resolve => setTimeout(resolve, 300));
        
        // Проверяем еще раз
        const finalCheckSenders = pc.getSenders();
        const finalHasAudio = finalCheckSenders.some(sender => sender.track && sender.track.kind === 'audio');
        if (!finalHasAudio) {
          console.error(`[AudioChat] ❌❌❌ STILL NO AUDIO TRACK after retry for ${participantEmailLower} ❌❌❌`);
          return; // Не создаем offer без аудио трека
        } else {
          console.log(`[AudioChat] ✅ Audio track found after retry for ${participantEmailLower}`);
        }
      } else {
        console.log(`[AudioChat] ✅ Audio track confirmed before creating offer for ${participantEmailLower}`);
      }

      // КРИТИЧЕСКИ ВАЖНО: Проверяем состояние перед созданием offer
      if (pc.signalingState === 'have-remote-offer' || pc.signalingState === 'have-local-offer') {
        console.warn(`[AudioChat] Cannot create offer in state ${pc.signalingState} for ${participantEmailLower}, waiting...`);
        // Ждем, пока состояние не станет stable
        await new Promise((resolve) => {
          const checkState = setInterval(() => {
            if (pc.signalingState === 'stable') {
              clearInterval(checkState);
              resolve();
            } else if (pc.signalingState === 'closed') {
              clearInterval(checkState);
              console.error(`[AudioChat] Connection closed for ${participantEmailLower}`);
              return;
            }
          }, 100);
          
          // Таймаут на случай, если состояние не изменится
          setTimeout(() => {
            clearInterval(checkState);
            if (pc.signalingState !== 'stable') {
              console.error(`[AudioChat] Timeout waiting for stable state for ${participantEmailLower}, current state: ${pc.signalingState}`);
            }
            resolve();
          }, 5000);
        });
      }
      
      // Проверяем еще раз перед созданием offer
      if (pc.signalingState !== 'stable' && pc.signalingState !== 'have-local-pranswer') {
        console.error(`[AudioChat] Cannot create offer in state ${pc.signalingState} for ${participantEmailLower}`);
        return;
      }
      
      const offer = await pc.createOffer();
      
      console.log(`[AudioChat] Created offer for ${participantEmailLower}, signalingState: ${pc.signalingState}`);
      
      // КРИТИЧЕСКИ ВАЖНО: Проверяем состояние перед установкой local description
      if (pc.signalingState === 'have-remote-offer') {
        console.error(`[AudioChat] Cannot set local offer when have-remote-offer for ${participantEmailLower}`);
        // Если есть remote offer, нужно сначала создать answer
        return;
      }
      
      await pc.setLocalDescription(offer);
      
      console.log(`[AudioChat] Sending offer to ${participantEmailLower}`);
      this.ws.send(JSON.stringify({
        type: 'audio_chat_offer',
        audio_room_id: this.currentAudioChat.audio_room_id,
        offer: offer,
        target_email: participantEmailLower
      }));
      
      console.log(`[AudioChat] Offer sent to ${participantEmailLower}`);
    } catch (error) {
      console.error(`[AudioChat] Error creating offer for ${participantEmailLower}:`, error);
    }
  }

  /**
   * Обрабатывает SDP offer от участника аудио-чата
   */
  async handleAudioChatOffer(offer, fromEmail) {
    const fromEmailLower = fromEmail.toLowerCase();
    console.log(`[AudioChat] Handling offer from ${fromEmailLower}`);
    
    // КРИТИЧЕСКИ ВАЖНО: Убеждаемся, что у нас есть локальный поток
    if (!this.localStream) {
      console.error(`[AudioChat] No local stream when handling offer from ${fromEmailLower}, getting stream...`);
      try {
        this.localStream = await navigator.mediaDevices.getUserMedia(
          this.getAudioConstraints(false)
        );
        console.log(`[AudioChat] Got local stream with ${this.localStream.getTracks().length} tracks`);
      } catch (error) {
        console.error(`[AudioChat] Error getting local stream:`, error);
        return;
      }
    }
    
    const pc = await this.createPeerConnectionForParticipant(fromEmailLower);
    
    try {
      const senders = pc.getSenders();
      const hasAudioTrack = senders.some(sender => sender.track && sender.track.kind === 'audio');
      
      if (!hasAudioTrack) {
        console.log(`[AudioChat] Adding local tracks before handling offer from ${fromEmailLower}`);
        this.localStream.getTracks().forEach(track => {
          if (track.readyState === 'live') {
            try {
              const sender = pc.addTrack(track, this.localStream);
              track.enabled = true;
              // Примечание: track.muted - это только геттер, его нельзя установить
              console.log(`[AudioChat] Added track before offer:`, track.kind, track.id);
            } catch (e) {
              console.error(`[AudioChat] Error adding track before offer:`, e);
            }
          }
        });
      } else {
        // Убеждаемся, что существующие треки включены
        senders.forEach(sender => {
          if (sender.track) {
            sender.track.enabled = true;
            // Примечание: track.muted - это только геттер, его нельзя установить
          }
        });
      }

      // КРИТИЧЕСКИ ВАЖНО: Убеждаемся, что локальные треки добавлены ПЕРЕД установкой remote description
      const sendersBeforeRemote = pc.getSenders();
      const hasAudioBefore = sendersBeforeRemote.some(sender => sender.track && sender.track.kind === 'audio');
      
      if (!hasAudioBefore) {
        console.log(`[AudioChat] No audio track before setting remote description, adding local tracks...`);
        this.localStream.getTracks().forEach(track => {
          if (track.readyState === 'live') {
            try {
              const sender = pc.addTrack(track, this.localStream);
              track.enabled = true;
              // Примечание: track.muted - это только геттер, его нельзя установить
              console.log(`[AudioChat] Added local track before remote description:`, track.kind, track.id);
            } catch (e) {
              console.error(`[AudioChat] Error adding track before remote description:`, e);
            }
          }
        });
        // Ждем, чтобы треки добавились
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      
      // КРИТИЧЕСКИ ВАЖНО: Проверяем состояние перед установкой remote description
      console.log(`[AudioChat] Current signaling state before setting remote description: ${pc.signalingState}`);
      
      if (pc.signalingState === 'have-local-offer' || pc.signalingState === 'have-remote-offer') {
        console.warn(`[AudioChat] Cannot set remote description in state ${pc.signalingState} for ${fromEmailLower}`);
        // Если уже есть offer, нужно сначала обработать его или закрыть соединение
        if (pc.signalingState === 'have-remote-offer') {
          console.log(`[AudioChat] Already have remote offer, creating answer instead...`);
          // Пытаемся создать answer для существующего offer
          try {
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            this.ws.send(JSON.stringify({
              type: 'audio_chat_answer',
              audio_room_id: this.currentAudioChat.audio_room_id,
              answer: answer,
              target_email: fromEmailLower
            }));
            console.log(`[AudioChat] Created and sent answer for existing offer from ${fromEmailLower}`);
            return;
          } catch (error) {
            console.error(`[AudioChat] Error creating answer for existing offer:`, error);
          }
        }
        // Если есть local offer, закрываем соединение и создаем новое
        console.log(`[AudioChat] Closing connection and creating new one for ${fromEmailLower}`);
        pc.close();
        this.audioChatPeerConnections.delete(fromEmailLower);
        // Создаем новое соединение (треки уже добавлены внутри createPeerConnectionForParticipant)
        const newPc = await this.createPeerConnectionForParticipant(fromEmailLower);
        await new Promise(resolve => setTimeout(resolve, 100));
        // Теперь устанавливаем remote description
        await newPc.setRemoteDescription(new RTCSessionDescription(offer));
        // Обрабатываем отложенные ICE кандидаты
        await this.processPendingIceCandidates(fromEmailLower);
        // Создаем answer
        const answer = await newPc.createAnswer();
        await newPc.setLocalDescription(answer);
        this.ws.send(JSON.stringify({
          type: 'audio_chat_answer',
          audio_room_id: this.currentAudioChat.audio_room_id,
          answer: answer,
          target_email: fromEmailLower
        }));
        console.log(`[AudioChat] Created and sent answer for ${fromEmailLower}`);
        return;
      }
      
      console.log(`[AudioChat] Setting remote description from ${fromEmailLower}`);
      await pc.setRemoteDescription(new RTCSessionDescription(offer));
      // Обрабатываем отложенные ICE кандидаты
      await this.processPendingIceCandidates(fromEmailLower);
      
      // КРИТИЧЕСКИ ВАЖНО: Проверяем, что локальные треки все еще есть после установки remote description
      const finalSenders = pc.getSenders();
      const hasAudio = finalSenders.some(sender => sender.track && sender.track.kind === 'audio');
      
      if (!hasAudio) {
        console.error(`[AudioChat] No audio track in senders after setting remote description, re-adding...`);
        // Пытаемся добавить еще раз
        this.localStream.getTracks().forEach(track => {
          if (track.readyState === 'live') {
            try {
              const sender = pc.addTrack(track, this.localStream);
              track.enabled = true;
              // Примечание: track.muted - это только геттер, его нельзя установить
              console.log(`[AudioChat] Re-added local track:`, track.kind, track.id);
            } catch (e) {
              console.error(`[AudioChat] Error re-adding track:`, e);
            }
          }
        });
        // Ждем, чтобы треки добавились
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      
      // КРИТИЧЕСКИ ВАЖНО: Убеждаемся, что локальные треки включены перед созданием answer
      const sendersBeforeAnswer = pc.getSenders();
      sendersBeforeAnswer.forEach(sender => {
        if (sender.track) {
          sender.track.enabled = true;
          // Примечание: track.muted - это только геттер, его нельзя установить
        }
      });
      
        const answer = await pc.createAnswer();
      
      console.log(`[AudioChat] Created answer for ${fromEmailLower}`);
      await pc.setLocalDescription(answer);
      
      this.ws.send(JSON.stringify({
        type: 'audio_chat_answer',
        audio_room_id: this.currentAudioChat.audio_room_id,
        answer: answer,
        target_email: fromEmailLower
      }));
      
      console.log(`[AudioChat] Sent answer to ${fromEmailLower}`);
    } catch (error) {
      console.error('[AudioChat] Error handling offer from', fromEmailLower, ':', error);
    }
  }

  /**
   * Обрабатывает SDP answer от участника аудио-чата
   */
  async handleAudioChatAnswer(answer, fromEmail) {
    const fromEmailLower = fromEmail.toLowerCase();
    let pc = this.audioChatPeerConnections.get(fromEmailLower);
    
    if (!pc) {
      console.warn(`[AudioChat] No peer connection for ${fromEmailLower}, creating new one...`);
      // Создаем новое соединение если его нет
      await this.createPeerConnectionForParticipant(fromEmailLower);
      pc = this.audioChatPeerConnections.get(fromEmailLower);
      if (!pc) {
        console.error(`[AudioChat] Failed to create peer connection for ${fromEmailLower}`);
        return;
      }
    }

    try {
      // КРИТИЧЕСКИ ВАЖНО: Проверяем состояние перед установкой remote description
      console.log(`[AudioChat] Current signaling state before setting remote answer: ${pc.signalingState}`);
      
      // Правильное состояние для установки answer - это 'have-local-offer'
      // Если состояние другое, нужно обработать это
      if (pc.signalingState === 'closed') {
        console.warn(`[AudioChat] Connection is closed for ${fromEmailLower}, creating new one...`);
        pc.close();
        this.audioChatPeerConnections.delete(fromEmailLower);
        await this.createPeerConnectionForParticipant(fromEmailLower);
        pc = this.audioChatPeerConnections.get(fromEmailLower);
        if (!pc) {
          console.error(`[AudioChat] Failed to create new peer connection for ${fromEmailLower}`);
          return;
        }
        // Если соединение было закрыто, answer уже не актуален, нужно создать новое offer
        console.log(`[AudioChat] Creating new offer for ${fromEmailLower} after connection was closed`);
        await this.createAndSendOfferForParticipant(fromEmailLower);
        return;
      }
      
      if (pc.signalingState === 'have-remote-offer') {
        console.warn(`[AudioChat] Already have remote offer for ${fromEmailLower}, cannot set answer. Creating answer for existing offer...`);
        // Если уже есть remote offer, создаем answer для него
        try {
          // Убеждаемся, что локальные треки добавлены
          if (this.localStream) {
            const senders = pc.getSenders();
            const hasAudio = senders.some(sender => sender.track && sender.track.kind === 'audio');
            if (!hasAudio) {
              this.localStream.getTracks().forEach(track => {
                if (track.readyState === 'live') {
                  try {
                    pc.addTrack(track, this.localStream);
                    track.enabled = true;
                  } catch (e) {
                    console.error(`[AudioChat] Error adding track:`, e);
                  }
                }
              });
              await new Promise(resolve => setTimeout(resolve, 100));
            }
          }
          
          const answerForOffer = await pc.createAnswer();
          await pc.setLocalDescription(answerForOffer);
          this.ws.send(JSON.stringify({
            type: 'audio_chat_answer',
            audio_room_id: this.currentAudioChat.audio_room_id,
            answer: answerForOffer,
            target_email: fromEmailLower
          }));
          console.log(`[AudioChat] Created and sent answer for existing offer from ${fromEmailLower}`);
          return;
        } catch (error) {
          console.error(`[AudioChat] Error creating answer for existing offer:`, error);
          // Продолжаем с обработкой полученного answer
        }
      }
      
      if (pc.signalingState === 'stable') {
        console.warn(`[AudioChat] Connection is in stable state for ${fromEmailLower}, answer may be outdated. Creating new offer...`);
        // Если соединение в stable состоянии, answer уже не актуален, создаем новый offer
        await this.createAndSendOfferForParticipant(fromEmailLower);
        return;
      }
      
      if (pc.signalingState !== 'have-local-offer' && pc.signalingState !== 'have-local-pranswer') {
        console.warn(`[AudioChat] Unexpected signaling state ${pc.signalingState} for ${fromEmailLower}, waiting for correct state...`);
        // Ждем правильного состояния с таймаутом
        let attempts = 0;
        const maxAttempts = 10;
        while (pc.signalingState !== 'have-local-offer' && pc.signalingState !== 'have-local-pranswer' && attempts < maxAttempts) {
          await new Promise(resolve => setTimeout(resolve, 100));
          attempts++;
          if (pc.signalingState === 'closed') {
            console.error(`[AudioChat] Connection closed while waiting for correct state for ${fromEmailLower}`);
            return;
          }
        }
        
        if (pc.signalingState !== 'have-local-offer' && pc.signalingState !== 'have-local-pranswer') {
          console.error(`[AudioChat] Timeout waiting for correct state for ${fromEmailLower}, current state: ${pc.signalingState}`);
          // Пересоздаем соединение
          pc.close();
          this.audioChatPeerConnections.delete(fromEmailLower);
          await this.createPeerConnectionForParticipant(fromEmailLower);
          pc = this.audioChatPeerConnections.get(fromEmailLower);
          if (!pc) {
            console.error(`[AudioChat] Failed to create new peer connection for ${fromEmailLower}`);
            return;
          }
          // Создаем новый offer
          await this.createAndSendOfferForParticipant(fromEmailLower);
          return;
        }
      }
      
      // КРИТИЧЕСКИ ВАЖНО: Убеждаемся, что локальные треки добавлены ПЕРЕД установкой remote description
      if (this.localStream) {
        const senders = pc.getSenders();
        const hasAudio = senders.some(sender => sender.track && sender.track.kind === 'audio');
        if (!hasAudio) {
          console.log(`[AudioChat] No audio track before setting remote answer, adding local tracks...`);
          this.localStream.getTracks().forEach(track => {
            if (track.readyState === 'live') {
              try {
                pc.addTrack(track, this.localStream);
                track.enabled = true;
              } catch (e) {
                console.error(`[AudioChat] Error adding track before remote answer:`, e);
              }
            }
          });
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }
      
      console.log(`[AudioChat] Setting remote description (answer) from ${fromEmailLower}, signalingState: ${pc.signalingState}`);
      await pc.setRemoteDescription(new RTCSessionDescription(answer));
      // Обрабатываем отложенные ICE кандидаты
      await this.processPendingIceCandidates(fromEmailLower);
      
      // Проверяем состояние соединения
      console.log(`[AudioChat] Connection state after answer:`, {
        connectionState: pc.connectionState,
        iceConnectionState: pc.iceConnectionState,
        signalingState: pc.signalingState
      });
      
      // Убеждаемся, что локальные треки все еще есть
      const senders = pc.getSenders();
      console.log(`[AudioChat] Senders after answer:`, senders.length);
      senders.forEach(sender => {
        console.log(`[AudioChat] Sender:`, {
          track: sender.track?.kind,
          trackId: sender.track?.id,
          trackEnabled: sender.track?.enabled,
          trackReadyState: sender.track?.readyState
        });
      });
      
      console.log(`[AudioChat] Successfully processed answer from ${fromEmailLower}`);
      
      // КРИТИЧЕСКИ ВАЖНО: Проверяем receivers после установления answer
      setTimeout(() => {
        const receivers = pc.getReceivers();
        console.log(`[AudioChat] Receivers after answer:`, receivers.length);
        receivers.forEach(receiver => {
          if (receiver.track) {
            console.log(`[AudioChat] Receiver track:`, {
              kind: receiver.track.kind,
              enabled: receiver.track.enabled,
              readyState: receiver.track.readyState
            });
            receiver.track.enabled = true;
            // Примечание: track.muted - это только геттер, его нельзя установить
            
            // КРИТИЧЕСКИ ВАЖНО: Добавляем обработчик для завершения трека
            receiver.track.onended = () => {
              console.warn(`[AudioChat] Receiver track ${receiver.track.id} from ${fromEmailLower} ended - attempting to recover...`);
              setTimeout(() => {
                this.recoverStreamFromReceivers(fromEmailLower);
              }, 100);
            };
            
            // Если трек еще не в потоке, создаем поток
            if (!this.audioChatRemoteStreams.has(fromEmailLower)) {
              const stream = new MediaStream([receiver.track]);
              // Убеждаемся, что трек включен
              receiver.track.enabled = true;
              // Примечание: track.muted - это только геттер, его нельзя установить
              this.audioChatRemoteStreams.set(fromEmailLower, stream);
              console.log(`[AudioChat] Created stream from receiver track for ${fromEmailLower}`);
              // Вызываем обработчик немедленно
              this.onAudioChatRemoteStreamReceived(stream, fromEmailLower);
            } else {
              // Если поток уже есть, добавляем трек в него
              const existingStream = this.audioChatRemoteStreams.get(fromEmailLower);
              if (existingStream && !existingStream.getTracks().includes(receiver.track)) {
                existingStream.addTrack(receiver.track);
                receiver.track.enabled = true;
                // Примечание: track.muted - это только геттер, его нельзя установить
                console.log(`[AudioChat] Added receiver track to existing stream for ${fromEmailLower}`);
                // Обновляем audio элемент
                setTimeout(() => {
                  this.onAudioChatRemoteStreamReceived(existingStream, fromEmailLower);
                }, 100);
              }
            }
          }
        });
      }, 500);
    } catch (error) {
      console.error(`[AudioChat] Error handling answer from ${fromEmailLower}:`, error);
      
      // КРИТИЧЕСКИ ВАЖНО: Если произошла ошибка InvalidStateError, пересоздаем соединение
      if (error.name === 'InvalidStateError' || error.message.includes('wrong state')) {
        console.warn(`[AudioChat] InvalidStateError detected for ${fromEmailLower}, recreating connection...`);
        try {
          // Закрываем старое соединение
          if (pc && pc.signalingState !== 'closed') {
            pc.close();
          }
          this.audioChatPeerConnections.delete(fromEmailLower);
          
          // Удаляем старый remote stream
          const oldStream = this.audioChatRemoteStreams.get(fromEmailLower);
          if (oldStream) {
            oldStream.getTracks().forEach(track => {
              try {
                track.stop();
              } catch (e) {
                console.error(`[AudioChat] Error stopping old track:`, e);
              }
            });
            this.audioChatRemoteStreams.delete(fromEmailLower);
          }
          
          // Создаем новое соединение (треки уже добавлены внутри createPeerConnectionForParticipant)
          await this.createPeerConnectionForParticipant(fromEmailLower);
          const newPc = this.audioChatPeerConnections.get(fromEmailLower);
          
          if (newPc) {
            await new Promise(resolve => setTimeout(resolve, 100));
            
            // Создаем новый offer
            console.log(`[AudioChat] Creating new offer for ${fromEmailLower} after InvalidStateError`);
            await this.createAndSendOfferForParticipant(fromEmailLower);
          }
        } catch (recreateError) {
          console.error(`[AudioChat] Error recreating connection for ${fromEmailLower}:`, recreateError);
        }
      }
    }
  }

  /**
   * Отправляет ICE candidate участнику аудио-чата
   */
  sendIceCandidateToParticipant(candidate, targetEmail) {
    const targetEmailLower = targetEmail.toLowerCase();
    
    if (this.currentAudioChat && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        type: 'audio_chat_ice_candidate',
        audio_room_id: this.currentAudioChat.audio_room_id,
        candidate: candidate,
        target_email: targetEmailLower
      }));
    }
  }

  /**
   * Обрабатывает отложенные ICE кандидаты после установки remote description
   */
  async processPendingIceCandidates(fromEmailLower) {
    if (!this.pendingIceCandidates || !this.pendingIceCandidates.has(fromEmailLower)) {
      return;
    }

    const pc = this.audioChatPeerConnections.get(fromEmailLower);
    if (!pc || !pc.remoteDescription) {
      return;
    }

    const pendingCandidates = this.pendingIceCandidates.get(fromEmailLower);
    console.log(`[AudioChat] Processing ${pendingCandidates.length} pending ICE candidates for ${fromEmailLower}`);
    
    for (const candidate of pendingCandidates) {
      try {
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
        console.log(`[AudioChat] Added pending ICE candidate from ${fromEmailLower}`);
      } catch (error) {
        console.error(`[AudioChat] Error adding pending ICE candidate from ${fromEmailLower}:`, error);
      }
    }
    
    // Очищаем обработанные кандидаты
    this.pendingIceCandidates.delete(fromEmailLower);
  }

  /**
   * Обрабатывает ICE candidate от участника аудио-чата
   */
  async handleAudioChatIceCandidate(candidate, fromEmail) {
    const fromEmailLower = fromEmail.toLowerCase();
    const pc = this.audioChatPeerConnections.get(fromEmailLower);
    
    if (!pc) {
      console.warn(`[AudioChat] No peer connection for ${fromEmailLower} when adding ICE candidate`);
      return;
    }

    // КРИТИЧЕСКИ ВАЖНО: Проверяем, что remote description установлен перед добавлением ICE кандидата
    if (!pc.remoteDescription) {
      console.warn(`[AudioChat] Cannot add ICE candidate: remote description not set yet for ${fromEmailLower}. Queueing candidate...`);
      // Сохраняем кандидата для добавления позже
      if (!this.pendingIceCandidates) {
        this.pendingIceCandidates = new Map();
      }
      if (!this.pendingIceCandidates.has(fromEmailLower)) {
        this.pendingIceCandidates.set(fromEmailLower, []);
      }
      if (candidate) {
        this.pendingIceCandidates.get(fromEmailLower).push(candidate);
      }
      return;
    }

    try {
      if (candidate) {
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
        console.log(`[AudioChat] Added ICE candidate from ${fromEmailLower}`);
      } else {
        console.log(`[AudioChat] Null ICE candidate from ${fromEmailLower} (end of candidates)`);
      }
    } catch (error) {
      console.error(`[AudioChat] Error adding ICE candidate from ${fromEmailLower}:`, error);
    }
  }

  /**
   * Переключает микрофон в аудио-чате
   */
  toggleAudioChatMic() {
    if (!this.localStream) return;

    const audioTracks = this.localStream.getAudioTracks();
    audioTracks.forEach(track => {
      track.enabled = !track.enabled;
    });
  }

  /**
   * Очищает только соединения аудио-чата (без удаления информации о чате)
   * Используется при выходе, чтобы можно было зайти обратно
   */
  cleanupAudioChatConnections() {
    // Останавливаем локальные треки
    if (this.localStream) {
      this.localStream.getTracks().forEach(track => {
        try {
          track.stop();
        } catch (error) {
          console.error('[AudioChat] Error stopping local track:', error);
        }
      });
      this.localStream = null;
    }

    // Закрываем все peer connections
    this.audioChatPeerConnections.forEach((pc, email) => {
      try {
        pc.close();
      } catch (error) {
        console.error(`[AudioChat] Error closing peer connection with ${email}:`, error);
      }
    });
    this.audioChatPeerConnections.clear();
    
    // Останавливаем remote streams
    this.audioChatRemoteStreams.forEach((stream, email) => {
      stream.getTracks().forEach(track => {
        try {
          track.stop();
        } catch (error) {
          console.error(`[AudioChat] Error stopping remote track from ${email}:`, error);
        }
      });
    });
    this.audioChatRemoteStreams.clear();
    
    // НЕ очищаем currentAudioChat и pendingAudioChat
    // чтобы можно было зайти обратно
  }

  /**
   * Полностью очищает ресурсы аудио-чата (используется при завершении чата)
   */
  cleanupAudioChat() {
    this.cleanupAudioChatConnections();
    this.currentAudioChat = null;
    this.pendingAudioChat = null;
  }

  /**
   * Генерирует уникальный ID звонка
   */
  generateCallId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2);
  }

  /**
   * Обработчики UI (будут переопределены в main.js)
   */
  showIncomingCallUI(callData) {
    console.log('[Calls] Incoming call:', callData);
  }

  showCallingUI() {
    console.log('[Calls] Calling...');
  }

  showActiveCallUI() {
    console.log('[Calls] Call active');
  }

  hideCallUI() {
    console.log('[Calls] Call ended');
  }

  onRemoteStreamReceived(stream) {
    console.log('[Calls] Remote stream received');
  }

  handleConnectionError() {
    console.error('[Calls] Connection error');
    this.endCall();
  }

  // Аудио-чаты UI
  showAudioChatBanner(data) {
    console.log('[AudioChat] Show banner:', data);
  }

  hideAudioChatBanner() {
    console.log('[AudioChat] Hide banner');
  }

  showAudioChatUI() {
    console.log('[AudioChat] Show UI');
  }

  hideAudioChatUI() {
    console.log('[AudioChat] Hide UI');
  }

  onAudioChatRemoteStreamReceived(stream, participantEmail) {
    console.log('[AudioChat] Remote stream received from', participantEmail);
  }

  /**
   * Восстанавливает поток из receivers, когда треки завершились
   */
  recoverStreamFromReceivers(participantEmailLower) {
    const pc = this.audioChatPeerConnections.get(participantEmailLower);
    if (!pc) {
      console.warn(`[AudioChat] No peer connection for ${participantEmailLower} to recover stream`);
      return;
    }

    const receivers = pc.getReceivers();
    console.log(`[AudioChat] Attempting to recover stream for ${participantEmailLower}, receivers: ${receivers.length}`);
    
    const activeTracks = [];
    receivers.forEach(receiver => {
      if (receiver.track) {
        // Проверяем состояние трека
        if (receiver.track.readyState === 'live') {
          receiver.track.enabled = true;
          activeTracks.push(receiver.track);
          
          // Добавляем обработчик для завершения трека
          receiver.track.onended = () => {
            console.warn(`[AudioChat] Recovered receiver track ${receiver.track.id} from ${participantEmailLower} ended - attempting to recover again...`);
            setTimeout(() => {
              this.recoverStreamFromReceivers(participantEmailLower);
            }, 100);
          };
          
          console.log(`[AudioChat] Found active receiver track for ${participantEmailLower}:`, {
            id: receiver.track.id,
            kind: receiver.track.kind,
            readyState: receiver.track.readyState
          });
        } else {
          console.warn(`[AudioChat] Receiver track ${receiver.track.id} is not live, state: ${receiver.track.readyState}`);
        }
      }
    });

    if (activeTracks.length > 0) {
      // Создаем новый поток из активных треков
      const newStream = new MediaStream(activeTracks);
      this.audioChatRemoteStreams.set(participantEmailLower, newStream);
      console.log(`[AudioChat] ✅ Recovered stream for ${participantEmailLower} with ${activeTracks.length} active tracks`);
      
      // Вызываем обработчик для обновления audio элемента
      this.onAudioChatRemoteStreamReceived(newStream, participantEmailLower);
    } else {
      console.warn(`[AudioChat] No active tracks found in receivers for ${participantEmailLower}`);
      // Если нет активных треков, проверяем состояние соединения
      if (pc.connectionState === 'connected' || pc.connectionState === 'connecting') {
        console.log(`[AudioChat] Connection is ${pc.connectionState}, waiting for new tracks...`);
        // Ждем немного и проверяем снова
        setTimeout(() => {
          this.recoverStreamFromReceivers(participantEmailLower);
        }, 1000);
      } else {
        console.warn(`[AudioChat] Connection state is ${pc.connectionState}, cannot recover stream`);
      }
    }
  }
}

// Экспортируем для использования в main.js
export default CallManager;
