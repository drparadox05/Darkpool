pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

contract DarkPoolSettlement is EIP712, ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct SwapOrder {
        address maker;
        address taker;
        address sellToken;
        address buyToken;
        uint256 sellAmount;
        uint256 buyAmount;
        uint256 expiry;
        uint256 nonce;
    }

    bytes32 public constant SWAP_ORDER_TYPEHASH = keccak256(
        "SwapOrder(address maker,address taker,address sellToken,address buyToken,uint256 sellAmount,uint256 buyAmount,uint256 expiry,uint256 nonce)"
    );

    mapping(bytes32 orderHash => bool used) public usedOrderHashes;
    mapping(bytes32 orderHash => bool cancelled) public cancelledOrderHashes;

    event Trade(
        bytes32 indexed orderHashA,
        bytes32 indexed orderHashB,
        address indexed makerA,
        address makerB,
        address sellTokenA,
        address sellTokenB,
        uint256 sellAmountA,
        uint256 sellAmountB
    );

    event OrderCancelled(bytes32 indexed orderHash, address indexed maker, uint256 nonce);

    error ExpiredOrder(bytes32 orderHash);
    error InvalidCounterparty();
    error InvalidOrderShape();
    error InvalidSignature(bytes32 orderHash, address signer, address expectedSigner);
    error MismatchedOrders();
    error OrderAlreadyFinalized(bytes32 orderHash);
    error UnauthorizedCancel();

    constructor() EIP712("DarkPoolSettlement", "1") {}

    function settle(
        SwapOrder calldata orderA,
        SwapOrder calldata orderB,
        bytes calldata signatureA,
        bytes calldata signatureB
    ) external nonReentrant returns (bytes32 orderHashA, bytes32 orderHashB) {
        orderHashA = hashOrder(orderA);
        orderHashB = hashOrder(orderB);

        _validateOrder(orderA, orderHashA);
        _validateOrder(orderB, orderHashB);
        _validateMatch(orderA, orderB);
        _validateSignature(orderHashA, orderA.maker, signatureA);
        _validateSignature(orderHashB, orderB.maker, signatureB);

        usedOrderHashes[orderHashA] = true;
        usedOrderHashes[orderHashB] = true;

        IERC20(orderA.sellToken).safeTransferFrom(orderA.maker, orderB.maker, orderA.sellAmount);
        IERC20(orderB.sellToken).safeTransferFrom(orderB.maker, orderA.maker, orderB.sellAmount);

        emit Trade(
            orderHashA,
            orderHashB,
            orderA.maker,
            orderB.maker,
            orderA.sellToken,
            orderB.sellToken,
            orderA.sellAmount,
            orderB.sellAmount
        );
    }

    function cancelOrder(SwapOrder calldata order) external returns (bytes32 orderHash) {
        if (msg.sender != order.maker) revert UnauthorizedCancel();

        orderHash = hashOrder(order);

        if (usedOrderHashes[orderHash] || cancelledOrderHashes[orderHash]) {
            revert OrderAlreadyFinalized(orderHash);
        }

        cancelledOrderHashes[orderHash] = true;
        emit OrderCancelled(orderHash, order.maker, order.nonce);
    }

    function hashOrder(SwapOrder calldata order) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    SWAP_ORDER_TYPEHASH,
                    order.maker,
                    order.taker,
                    order.sellToken,
                    order.buyToken,
                    order.sellAmount,
                    order.buyAmount,
                    order.expiry,
                    order.nonce
                )
            )
        );
    }

    function _validateOrder(SwapOrder calldata order, bytes32 orderHash) private view {
        if (usedOrderHashes[orderHash] || cancelledOrderHashes[orderHash]) {
            revert OrderAlreadyFinalized(orderHash);
        }

        if (order.expiry < block.timestamp) revert ExpiredOrder(orderHash);

        if (
            order.maker == address(0) || order.taker == address(0) || order.sellToken == address(0)
                || order.buyToken == address(0) || order.sellAmount == 0 || order.buyAmount == 0
                || order.sellToken == order.buyToken
        ) {
            revert InvalidOrderShape();
        }
    }

    function _validateMatch(SwapOrder calldata orderA, SwapOrder calldata orderB) private pure {
        if (orderA.maker == orderB.maker) revert InvalidCounterparty();

        if (orderA.taker != orderB.maker || orderB.taker != orderA.maker) {
            revert InvalidCounterparty();
        }

        if (
            orderA.sellToken != orderB.buyToken || orderA.buyToken != orderB.sellToken
                || orderA.sellAmount != orderB.buyAmount || orderA.buyAmount != orderB.sellAmount
        ) {
            revert MismatchedOrders();
        }
    }

    function _validateSignature(bytes32 orderHash, address expectedSigner, bytes calldata signature) private pure {
        address signer = ECDSA.recover(orderHash, signature);

        if (signer != expectedSigner) {
            revert InvalidSignature(orderHash, signer, expectedSigner);
        }
    }
}
